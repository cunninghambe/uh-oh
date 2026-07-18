import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, type EventEnvelope, type FsLike } from './uh-oh-client.js';
import { fakeNavigator, fakeProcess, fakeStorage, fakeWindow, mockFetch } from './test-support.js';

const DSN = 'https://pk@errors.example.com';
const SPOOL_FILE = 'uh-oh-spool.json';
const BROWSER_SPOOL_KEY = 'uh-oh:spool';

// The real node:fs, structurally narrowed to the tiny surface the client uses.
const realFs = nodeFs as unknown as FsLike;

function freshDir(): string {
  return nodeFs.mkdtempSync(join(tmpdir(), 'uh-oh-spool-'));
}

interface FsCall {
  op: string;
  args: unknown[];
}

/**
 * An in-memory recording fs implementing the FsLike surface. Optionally fails
 * mkdir/write to exercise the unwritable-directory path.
 */
function recordingFs(opts: { failMkdir?: boolean; failWrite?: boolean } = {}): {
  fs: FsLike;
  calls: FsCall[];
  files: Map<string, string>;
} {
  const calls: FsCall[] = [];
  const files = new Map<string, string>();
  const fs: FsLike = {
    mkdirSync: (path: string, o?: { recursive?: boolean }): unknown => {
      calls.push({ op: 'mkdirSync', args: [path, o] });
      if (opts.failMkdir) throw new Error('EACCES: mkdir blocked');
      return undefined;
    },
    writeFileSync: (path: string, data: string): void => {
      calls.push({ op: 'writeFileSync', args: [path, data] });
      if (opts.failWrite) throw new Error('EACCES: write blocked');
      files.set(path, data);
    },
    renameSync: (from: string, to: string): void => {
      calls.push({ op: 'renameSync', args: [from, to] });
      const d = files.get(from);
      files.delete(from);
      if (d !== undefined) files.set(to, d);
    },
    readFileSync: (path: string): string => {
      calls.push({ op: 'readFileSync', args: [path] });
      const d = files.get(path);
      if (d === undefined) throw new Error('ENOENT');
      return d;
    },
    existsSync: (path: string): boolean => files.has(path),
    unlinkSync: (path: string): void => {
      calls.push({ op: 'unlinkSync', args: [path] });
      files.delete(path);
    },
  };
  return { fs, calls, files };
}

function nodeClient(opts: {
  fetchFn: ReturnType<typeof mockFetch>['fn'];
  fs: FsLike;
  spoolDir: string;
}): Client {
  return new Client(
    { dsn: DSN, release: '1.0.0', spoolDir: opts.spoolDir },
    { fetchFn: opts.fetchFn, fs: opts.fs, proc: fakeProcess().proc },
  );
}

describe('node disk spool', () => {
  it('persists the queue to disk offline and restores it on a fresh client', async () => {
    const dir = freshDir();
    try {
      const file = join(dir, SPOOL_FILE);

      const offline = mockFetch([{ reject: true }]);
      const c1 = nodeClient({ fetchFn: offline.fn, fs: realFs, spoolDir: dir });
      c1.captureException(new Error('offline crash'));
      await c1.flush();
      expect(c1.size()).toBe(1);
      c1.close(); // force-writes the spool

      expect(nodeFs.existsSync(file)).toBe(true);
      const onDisk: unknown = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
      expect(Array.isArray(onDisk)).toBe(true);
      expect(onDisk as unknown[]).toHaveLength(1);

      // A brand-new client (process restart) restores from disk and drains.
      const online = mockFetch();
      const c2 = nodeClient({ fetchFn: online.fn, fs: realFs, spoolDir: dir });
      c2.install();
      await c2.flush();
      expect(online.calls.length).toBeGreaterThanOrEqual(1);
      expect(c2.size()).toBe(0);
      c2.close();
      // Fully drained -> the spool file is removed.
      expect(nodeFs.existsSync(file)).toBe(false);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes atomically via a tmp file then rename (never a partial target)', async () => {
    const dir = '/spool';
    const file = `${dir}/${SPOOL_FILE}`;
    const tmp = `${file}.tmp`;
    const rec = recordingFs();

    const offline = mockFetch([{ reject: true }]);
    const c = nodeClient({ fetchFn: offline.fn, fs: rec.fs, spoolDir: dir });
    c.captureException(new Error('x'));
    await c.flush();
    c.close(); // force flush

    // The durable target must only ever appear via a rename, never a raw write.
    const directTargetWrites = rec.calls.filter(
      (k) => k.op === 'writeFileSync' && k.args[0] === file,
    );
    expect(directTargetWrites).toHaveLength(0);

    const idxWrite = rec.calls.findIndex((k) => k.op === 'writeFileSync' && k.args[0] === tmp);
    const idxRename = rec.calls.findIndex(
      (k) => k.op === 'renameSync' && k.args[0] === tmp && k.args[1] === file,
    );
    expect(idxWrite).toBeGreaterThanOrEqual(0);
    expect(idxRename).toBeGreaterThan(idxWrite);

    // Final state: the target holds the data, the tmp file is gone.
    expect(rec.files.has(file)).toBe(true);
    expect(rec.files.has(tmp)).toBe(false);
  });

  it('tolerates corrupt / junk spool files (discards without throwing)', async () => {
    for (const bad of ['not json {{{', '{"not":"an array"}', 'null', '42']) {
      const dir = freshDir();
      try {
        const file = join(dir, SPOOL_FILE);
        nodeFs.writeFileSync(file, bad);

        const c = nodeClient({ fetchFn: mockFetch().fn, fs: realFs, spoolDir: dir });
        expect(() => {
          c.install();
        }).not.toThrow();
        await c.flush();
        expect(c.size()).toBe(0);
        // The corrupt file is discarded.
        expect(nodeFs.existsSync(file)).toBe(false);
        c.close();
      } finally {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('keeps well-formed entries but drops malformed ones on restore', async () => {
    const dir = freshDir();
    try {
      const file = join(dir, SPOOL_FILE);
      nodeFs.writeFileSync(
        file,
        JSON.stringify([1, 'junk', null, { id: 'a', env: { hello: 'x' } }]),
      );
      const offline = mockFetch([{ reject: true }]);
      const c = nodeClient({ fetchFn: offline.fn, fs: realFs, spoolDir: dir });
      c.install();
      await c.flush();
      expect(c.size()).toBe(1);
      c.close();
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws when the spool directory is unwritable', async () => {
    const dir = '/nope';
    const file = `${dir}/${SPOOL_FILE}`;
    const rec = recordingFs({ failWrite: true });

    const offline = mockFetch([{ reject: true }]);
    const c = nodeClient({ fetchFn: offline.fn, fs: rec.fs, spoolDir: dir });
    c.captureException(new Error('x'));
    await c.flush();
    expect(() => {
      c.close();
    }).not.toThrow();
    // Nothing durable was written, and no half-written tmp lingers.
    expect(rec.files.has(file)).toBe(false);
    expect(rec.files.has(`${file}.tmp`)).toBe(false);
  });

  it('ignores spoolDir on the browser runtime (no fs writes; uses localStorage)', async () => {
    const rec = recordingFs();
    const store = fakeStorage();
    const offline = mockFetch([{ reject: true }]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0', spoolDir: '/should-be-ignored' },
      {
        fetchFn: offline.fn,
        fs: rec.fs,
        storage: store.storage,
        win: fakeWindow().win,
        doc: { visibilityState: 'visible' },
        navigator: fakeNavigator().nav,
      },
    );
    c.captureException(new Error('x'));
    await c.flush();
    // The disk spool is never touched on a browser runtime...
    expect(rec.calls).toHaveLength(0);
    // ...the browser localStorage spool is used instead.
    expect(store.map.get(BROWSER_SPOOL_KEY)).toBeTruthy();
    c.close();
  });

  it('enforces the 50-event cap when restoring from disk', async () => {
    const dir = freshDir();
    try {
      const file = join(dir, SPOOL_FILE);
      const many = Array.from({ length: 60 }, (_unused, i) => ({
        id: `id-${String(i)}`,
        env: { seq: i } as unknown as EventEnvelope,
      }));
      nodeFs.writeFileSync(file, JSON.stringify(many));

      const offline = mockFetch([{ reject: true }]);
      const c = nodeClient({ fetchFn: offline.fn, fs: realFs, spoolDir: dir });
      c.install();
      await c.flush();
      expect(c.size()).toBe(50);
      c.close();
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
