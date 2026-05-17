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

export class Spool {
  constructor(private readonly storage: AsyncStorageLike) {}

  async enqueue(env: EventEnvelope): Promise<void> {
    const queue = await this._read();
    const id = typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Date.now());
    queue.push({ id, env });

    // Drop oldest events while over caps
    while (queue.length > MAX_EVENTS) {
      queue.shift();
    }

    let serialized = JSON.stringify(queue);
    while (serialized.length > MAX_BYTES && queue.length > 1) {
      queue.shift();
      serialized = JSON.stringify(queue);
    }

    await this.storage.setItem(SPOOL_KEY, serialized);
  }

  async drain(send: (env: EventEnvelope) => Promise<SendResult>): Promise<void> {
    const queue = await this._read();
    if (queue.length === 0) return;

    const remaining: SpooledEvent[] = [];

    for (const item of queue) {
      const result = await send(item.env);

      if (result.ok) {
        // Sent successfully — do not re-add to remaining
        continue;
      }

      if (result.status === 413) {
        // Trim breadcrumbs to last 50 and retry once
        const trimmed: EventEnvelope = {
          ...item.env,
          breadcrumbs: item.env.breadcrumbs.slice(-50),
        };
        const retry = await send(trimmed);
        if (!retry.ok) {
          // Drop on second 413 or any other failure after trim
          continue;
        }
        // Retry succeeded — do not re-add
        continue;
      }

      // Network error or other non-2xx (not 413): stop draining
      remaining.push(item);
      // Preserve all subsequent events too
      const idx = queue.indexOf(item);
      remaining.push(...queue.slice(idx + 1));
      break;
    }

    if (remaining.length === 0) {
      await this.storage.removeItem(SPOOL_KEY);
    } else {
      await this.storage.setItem(SPOOL_KEY, JSON.stringify(remaining));
    }
  }

  async size(): Promise<number> {
    const queue = await this._read();
    return queue.length;
  }

  private async _read(): Promise<SpooledEvent[]> {
    const raw = await this.storage.getItem(SPOOL_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as SpooledEvent[];
    } catch {
      return [];
    }
  }
}
