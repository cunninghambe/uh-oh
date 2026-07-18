import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map';

import {
  loadSourceMap,
  resolveJsFrame,
  disposeSourceMap,
  getOrLoadCachedConsumer,
  invalidateCachedConsumer,
} from './sourcemap.js';

/**
 * Build a minimal source map with one mapping:
 *   generated line:col → original source file, orig line:col, name
 */
const buildSourceMap = (
  mapping: {
    genLine: number;
    genCol: number;
    source: string;
    origLine: number;
    origCol: number;
    name?: string;
  }[],
): string => {
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  for (const m of mapping) {
    gen.addMapping({
      generated: { line: m.genLine, column: m.genCol },
      original: { line: m.origLine, column: m.origCol },
      source: m.source,
      ...(m.name !== undefined ? { name: m.name } : {}),
    });
  }
  return gen.toString();
};

describe('loadSourceMap', () => {
  it('loads a valid source map and returns a consumer', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'orig.ts', origLine: 1, origCol: 0 },
    ]);
    const consumer = await loadSourceMap(raw);
    expect(consumer).toBeDefined();
    disposeSourceMap(consumer);
  });

  it('throws on corrupt source map JSON', async () => {
    await expect(loadSourceMap('not json at all {{')).rejects.toThrow();
  });
});

describe('resolveJsFrame', () => {
  it('returns original position for a known mapping', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'orig.ts', origLine: 5, origCol: 3, name: 'greet' },
    ]);
    const consumer = await loadSourceMap(raw);
    const pos = resolveJsFrame(consumer, { line: 1, column: 0 });
    expect(pos.source).toBe('orig.ts');
    expect(pos.line).toBe(5);
    expect(pos.column).toBe(3);
    expect(pos.name).toBe('greet');
    disposeSourceMap(consumer);
  });

  it('returns nulls for out-of-range generated position', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'orig.ts', origLine: 1, origCol: 0 },
    ]);
    const consumer = await loadSourceMap(raw);
    // Line 9999 has no mapping
    const pos = resolveJsFrame(consumer, { line: 9999, column: 0 });
    expect(pos.source).toBeNull();
    expect(pos.line).toBeNull();
    disposeSourceMap(consumer);
  });

  it('resolves multiple frames in sequence from the same consumer', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'a.ts', origLine: 10, origCol: 0 },
      { genLine: 2, genCol: 0, source: 'b.ts', origLine: 20, origCol: 4 },
    ]);
    const consumer = await loadSourceMap(raw);
    const pos1 = resolveJsFrame(consumer, { line: 1, column: 0 });
    const pos2 = resolveJsFrame(consumer, { line: 2, column: 0 });
    expect(pos1.source).toBe('a.ts');
    expect(pos1.line).toBe(10);
    expect(pos2.source).toBe('b.ts');
    expect(pos2.line).toBe(20);
    disposeSourceMap(consumer);
  });
});

describe('disposeSourceMap', () => {
  it('destroy is idempotent and does not throw', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'x.ts', origLine: 1, origCol: 0 },
    ]);
    const consumer = await loadSourceMap(raw);
    expect(() => disposeSourceMap(consumer)).not.toThrow();
  });
});

describe('getOrLoadCachedConsumer LRU cache', () => {
  beforeEach(() => {
    // Start clean
    for (let i = 0; i < 10; i++) {
      invalidateCachedConsumer(`lru-test-${i}`);
    }
  });

  afterEach(() => {
    for (let i = 0; i < 10; i++) {
      invalidateCachedConsumer(`lru-test-${i}`);
    }
  });

  it('returns same consumer on cache hit', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'c.ts', origLine: 1, origCol: 0 },
    ]);
    const first = await getOrLoadCachedConsumer('lru-test-0', raw);
    const second = await getOrLoadCachedConsumer('lru-test-0', raw);
    // Same object reference from cache
    expect(first).toBe(second);
    invalidateCachedConsumer('lru-test-0');
  });

  it('evicts oldest entry after LRU_MAX (4) distinct loads', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'e.ts', origLine: 1, origCol: 0 },
    ]);

    // Fill cache with 4 entries
    const c0 = await getOrLoadCachedConsumer('lru-test-0', raw);
    await getOrLoadCachedConsumer('lru-test-1', raw);
    await getOrLoadCachedConsumer('lru-test-2', raw);
    await getOrLoadCachedConsumer('lru-test-3', raw);

    // Adding a 5th should evict lru-test-0
    await getOrLoadCachedConsumer('lru-test-4', raw);

    // lru-test-0 was evicted, so a new load returns a different consumer instance
    const c0Again = await getOrLoadCachedConsumer('lru-test-0', raw);
    expect(c0Again).not.toBe(c0);

    // Cleanup
    for (let i = 0; i <= 4; i++) {
      invalidateCachedConsumer(`lru-test-${i}`);
    }
  });

  it('invalidateCachedConsumer removes the entry', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'f.ts', origLine: 1, origCol: 0 },
    ]);
    const first = await getOrLoadCachedConsumer('lru-test-5', raw);
    invalidateCachedConsumer('lru-test-5');
    const second = await getOrLoadCachedConsumer('lru-test-5', raw);
    expect(second).not.toBe(first);
    invalidateCachedConsumer('lru-test-5');
  });

  it('defers destroy — a consumer stays usable right after invalidation (M1b)', async () => {
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'g.ts', origLine: 7, origCol: 0, name: 'g' },
    ]);
    const consumer = await getOrLoadCachedConsumer('lru-test-6', raw);
    // An in-flight request already holds `consumer`. Invalidation must not
    // destroy it synchronously, or resolving would throw on destroyed WASM.
    invalidateCachedConsumer('lru-test-6');
    const pos = resolveJsFrame(consumer, { line: 1, column: 0 });
    expect(pos.source).toBe('g.ts');
    expect(pos.line).toBe(7);
  });
});
