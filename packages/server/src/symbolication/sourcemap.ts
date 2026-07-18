import {
  SourceMapConsumer,
  type BasicSourceMapConsumer,
  type IndexedSourceMapConsumer,
} from 'source-map';

export type SourcePosition = {
  source: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
};

type Consumer = BasicSourceMapConsumer | IndexedSourceMapConsumer;

// Cache-key separator. Android/Hermes uses the bare `releaseId` as key; web/node
// uses a composite `releaseId::platform::bundlePath` so one release can hold many
// per-bundle maps. `::` never appears in a releaseId (a UUID), and because the
// platform is always exactly `web` or `node`, the composite is unambiguous for
// every (releaseId, platform, bundlePath) triple regardless of the bundlePath.
const KEY_SEP = '::';

/** Composite consumer-cache key for a web/node per-bundle source map. */
export const webConsumerKey = (releaseId: string, platform: string, bundlePath: string): string =>
  `${releaseId}${KEY_SEP}${platform}${KEY_SEP}${bundlePath}`;

const LRU_MAX = 4;
// Delay before destroying an evicted/invalidated consumer, so any request that
// already grabbed a reference can finish resolving against it (destroying the
// underlying WASM mid-use throws).
const DESTROY_DELAY_MS = 10_000;

// LRU order: head = most-recently-used
const lruOrder: string[] = [];
const lruCache = new Map<string, Consumer>();

const deferDestroy = (consumer: Consumer): void => {
  const timer = setTimeout(() => {
    try {
      consumer.destroy();
    } catch {
      // Already destroyed — ignore.
    }
  }, DESTROY_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
};

const evictLru = (): void => {
  while (lruCache.size >= LRU_MAX) {
    const oldest = lruOrder.shift();
    if (oldest === undefined) break;
    const evicted = lruCache.get(oldest);
    if (evicted) deferDestroy(evicted);
    lruCache.delete(oldest);
  }
};

const touchLru = (key: string): void => {
  const idx = lruOrder.indexOf(key);
  if (idx !== -1) lruOrder.splice(idx, 1);
  lruOrder.push(key);
};

/**
 * Load a source map from its raw JSON string and add it to the LRU cache.
 * The returned consumer must be disposed via disposeSourceMap when no longer needed,
 * unless it comes from the cache (in which case the cache owns the lifecycle).
 */
export const loadSourceMap = async (raw: string): Promise<Consumer> => {
  const consumer = await new SourceMapConsumer(raw);
  return consumer;
};

/**
 * Get or load a cached source map consumer for a cache key (a bare releaseId for
 * Android/Hermes, or a webConsumerKey for a web/node per-bundle map).
 * The cache holds at most LRU_MAX consumers; oldest is evicted on overflow.
 */
export const getOrLoadCachedConsumer = async (key: string, raw: string): Promise<Consumer> => {
  const hit = lruCache.get(key);
  if (hit) {
    touchLru(key);
    return hit;
  }
  evictLru();
  const consumer = await loadSourceMap(raw);
  lruCache.set(key, consumer);
  lruOrder.push(key);
  return consumer;
};

/**
 * Invalidate every cached consumer for a release (e.g. after a new upload).
 * Clears the bare-releaseId key (Android/Hermes) and every composite web/node
 * key whose releaseId prefix matches.
 */
export const invalidateCachedConsumer = (releaseId: string): void => {
  const prefix = `${releaseId}${KEY_SEP}`;
  const keys = [...lruCache.keys()].filter((k) => k === releaseId || k.startsWith(prefix));
  for (const key of keys) {
    const consumer = lruCache.get(key);
    // Drop from the cache immediately, but defer the destroy: another in-flight
    // request may still hold this consumer reference.
    if (consumer) deferDestroy(consumer);
    lruCache.delete(key);
    const idx = lruOrder.indexOf(key);
    if (idx !== -1) lruOrder.splice(idx, 1);
  }
};

export const resolveJsFrame = (
  consumer: Consumer,
  generated: { line: number; column: number },
): SourcePosition => {
  const result = consumer.originalPositionFor({ line: generated.line, column: generated.column });
  return {
    source: result.source,
    line: result.line,
    column: result.column,
    name: result.name,
  };
};

export const disposeSourceMap = (consumer: Consumer): void => {
  consumer.destroy();
};
