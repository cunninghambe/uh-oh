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

const LRU_MAX = 4;

// LRU order: head = most-recently-used
const lruOrder: string[] = [];
const lruCache = new Map<string, Consumer>();

const evictLru = (): void => {
  while (lruCache.size >= LRU_MAX) {
    const oldest = lruOrder.shift();
    if (oldest === undefined) break;
    const evicted = lruCache.get(oldest);
    evicted?.destroy();
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
 * Get or load a cached source map consumer for a release.
 * The cache holds at most LRU_MAX consumers; oldest is evicted on overflow.
 */
export const getOrLoadCachedConsumer = async (
  releaseId: string,
  raw: string,
): Promise<Consumer> => {
  const hit = lruCache.get(releaseId);
  if (hit) {
    touchLru(releaseId);
    return hit;
  }
  evictLru();
  const consumer = await loadSourceMap(raw);
  lruCache.set(releaseId, consumer);
  lruOrder.push(releaseId);
  return consumer;
};

/**
 * Invalidate the cached consumer for a release (e.g. after a new upload).
 */
export const invalidateCachedConsumer = (releaseId: string): void => {
  const consumer = lruCache.get(releaseId);
  consumer?.destroy();
  lruCache.delete(releaseId);
  const idx = lruOrder.indexOf(releaseId);
  if (idx !== -1) lruOrder.splice(idx, 1);
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
