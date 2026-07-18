import type { EventEnvelope } from '@uh-oh/types';
import type { SendResult } from './transport.js';

const SPOOL_KEY = '@uh-oh/spool';
const MAX_EVENTS = 100;
const MAX_BYTES = 1_048_576;

export type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type SpooledEvent = { id: string; env: EventEnvelope };

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Durable, crash-safe event spool backed by AsyncStorage.
 *
 * Invariants:
 * - All store mutations are serialized through a promise-chain mutex, so
 *   concurrent enqueues never lose events and concurrent drains never send
 *   duplicates (H1).
 * - At most one drain runs at a time; a drain requested while one is in
 *   flight schedules exactly one follow-up (H1/L6).
 * - A drain only removes the ids it actually processed, re-reading the store
 *   at the end so events enqueued mid-drain are preserved (H1).
 */
export class Spool {
  private mutex: Promise<unknown> = Promise.resolve();
  private isDraining = false;
  private drainRequested = false;

  constructor(
    private readonly storage: AsyncStorageLike,
    private readonly debug: boolean = false,
  ) {}

  private log(msg: string): void {
    if (this.debug) console.debug(`uh-oh: ${msg}`);
  }

  /** Serialize a store operation onto the mutex chain. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.mutex.then(op, op);
    // Advance the chain, swallowing errors so one failed op doesn't poison it.
    this.mutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async enqueue(env: EventEnvelope): Promise<void> {
    return this.run(() => this._enqueueLocked(env));
  }

  private async _enqueueLocked(env: EventEnvelope): Promise<void> {
    const queue = await this._read();
    const entry: SpooledEvent = { id: genId(), env };

    // A single event that exceeds the byte cap can later make AsyncStorage
    // getItem fail entirely (Android 2 MB cursor window), losing the whole
    // spool. Trim it down; drop it outright if it still doesn't fit (L3).
    if (!this._fitEntry(entry)) {
      // Leave the existing queue untouched.
      return;
    }

    queue.push(entry);

    // Drop oldest events while over the count cap.
    while (queue.length > MAX_EVENTS) {
      queue.shift();
      this.log('spool over event cap (100); dropped oldest event');
    }

    // Drop oldest events while over the byte cap.
    let serialized = JSON.stringify(queue);
    while (serialized.length > MAX_BYTES && queue.length > 1) {
      queue.shift();
      this.log('spool over byte cap (1 MB); dropped oldest event');
      serialized = JSON.stringify(queue);
    }

    await this.storage.setItem(SPOOL_KEY, serialized);
  }

  /**
   * Ensures a single spooled entry fits under the byte cap by trimming
   * breadcrumbs then context. Returns false if it still doesn't fit and
   * should be dropped.
   */
  private _fitEntry(entry: SpooledEvent): boolean {
    if (JSON.stringify(entry).length <= MAX_BYTES) return true;

    entry.env = { ...entry.env, breadcrumbs: [] };
    if (JSON.stringify(entry).length <= MAX_BYTES) {
      this.log('single event over 1 MB; trimmed breadcrumbs to fit');
      return true;
    }

    if (entry.env.context !== undefined) {
      const next = { ...entry.env };
      delete next.context;
      entry.env = next;
    }
    if (JSON.stringify(entry).length <= MAX_BYTES) {
      this.log('single event over 1 MB; trimmed breadcrumbs and context to fit');
      return true;
    }

    this.log('single event exceeds 1 MB after trimming; dropped');
    return false;
  }

  /**
   * Drains the spool, coalescing concurrent requests: at most one drain runs
   * at a time and a request that arrives mid-drain triggers exactly one
   * follow-up pass.
   */
  async drain(send: (env: EventEnvelope) => Promise<SendResult>): Promise<void> {
    if (this.isDraining) {
      this.drainRequested = true;
      return;
    }
    this.isDraining = true;
    try {
      do {
        this.drainRequested = false;
        await this._drainOnce(send);
      } while (this.drainRequested);
    } finally {
      this.isDraining = false;
    }
  }

  private async _drainOnce(send: (env: EventEnvelope) => Promise<SendResult>): Promise<void> {
    // Snapshot the queue under the mutex, then release it so enqueues can
    // interleave with the (potentially slow) network sends below.
    const queue = await this.run(() => this._read());
    if (queue.length === 0) return;

    // id -> 'remove' (sent or dropped) | EventEnvelope (persist a trimmed version)
    const actions = new Map<string, 'remove' | EventEnvelope>();

    for (const item of queue) {
      const result = await send(item.env);

      if (result.ok) {
        actions.set(item.id, 'remove');
        continue;
      }

      if (result.status === 413) {
        // Payload too large: trim breadcrumbs to last 50 and retry once.
        const trimmed: EventEnvelope = {
          ...item.env,
          breadcrumbs: item.env.breadcrumbs.slice(-50),
        };
        const retry = await send(trimmed);
        if (retry.ok) {
          actions.set(item.id, 'remove');
          continue;
        }
        if (retry.status === 413) {
          // Second 413 (SPEC §12 #13): drop the event.
          this.log('event dropped after second 413 (payload too large)');
          actions.set(item.id, 'remove');
          continue;
        }
        // Any other failure after trimming: keep the TRIMMED event spooled
        // (so we don't resend the oversize payload) and stop draining.
        this.log('413 trim retry failed transiently; keeping trimmed event spooled');
        actions.set(item.id, trimmed);
        break;
      }

      // Poison-event guard: a 4xx (except 413/429) will never succeed, so drop
      // it and continue draining instead of blocking the queue forever (H2).
      if (
        result.status !== undefined &&
        result.status >= 400 &&
        result.status < 500 &&
        result.status !== 429
      ) {
        this.log(`event dropped on ${String(result.status)} response`);
        actions.set(item.id, 'remove');
        continue;
      }

      // Network error (no status), 5xx, or 429: retain and stop draining.
      this.log(
        result.status !== undefined
          ? `drain paused on ${String(result.status)} response; retaining events`
          : 'drain paused on network error; retaining events',
      );
      break;
    }

    // Re-read the store and apply only the actions we computed, so any events
    // enqueued during the sends above are preserved.
    await this.run(async () => {
      const current = await this._read();
      const next: SpooledEvent[] = [];
      for (const e of current) {
        const action = actions.get(e.id);
        if (action === 'remove') continue;
        if (action !== undefined) {
          next.push({ id: e.id, env: action });
        } else {
          next.push(e);
        }
      }
      if (next.length === 0) {
        await this.storage.removeItem(SPOOL_KEY);
      } else {
        await this.storage.setItem(SPOOL_KEY, JSON.stringify(next));
      }
    });
  }

  async size(): Promise<number> {
    return this.run(async () => (await this._read()).length);
  }

  private async _read(): Promise<SpooledEvent[]> {
    const raw = await this.storage.getItem(SPOOL_KEY);
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log('spool JSON parse failed; discarding corrupt spool');
      return [];
    }

    if (!Array.isArray(parsed)) {
      this.log('spool contents were not an array; discarding corrupt spool');
      return [];
    }

    const valid: SpooledEvent[] = [];
    for (const item of parsed) {
      if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        (item as { env?: unknown }).env !== null &&
        typeof (item as { env?: unknown }).env === 'object'
      ) {
        valid.push(item as SpooledEvent);
      } else {
        this.log('discarded malformed spool entry');
      }
    }
    return valid;
  }
}
