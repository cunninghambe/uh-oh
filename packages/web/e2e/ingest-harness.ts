// Real-browser ingest harness for browser-ingest.spec.ts: boots the BUILT @uh-oh/server
// (packages/server/dist, what production starts with `node dist/index.js`) in this process on a
// throwaway SQLite file, plus a second "app" origin that serves the BUILT @uh-oh/js client
// (packages/js/dist/uh-oh-client.js) to a page that calls init().
//
// Why in-process, when server-runner.ts spawns a child for the dashboard suite: the spec asserts
// on what the server actually received (method, status, content type, Sec-Fetch-Mode, the CORS
// headers it answered with, the parsed body), and recording that in the same process is a plain
// array instead of IPC. The dist is reached by a dynamic import from a computed path, never a
// static import, so @uh-oh/web gains no dependency on @uh-oh/server and its typecheck does not
// need a built dist (same cross-package trick as server-runner.ts and db.ts).
//
// Two env overrides pin a regression against an older build (both skip the freshness check):
//   UH_OH_E2E_SERVER_DIST  a directory holding another server build (its server.js, db/...)
//   UH_OH_E2E_JS_CLIENT    another built uh-oh-client.js
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { E2E_INGEST_APP_PORT, E2E_INGEST_SERVER_PORT } from './constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(here, '../..');
const BUILD_HINT = 'pnpm --filter @uh-oh/server... --filter @uh-oh/js build';

/** One request as the ingest server saw it, recorded when its response finished. */
export type IngestHit = {
  method: string;
  /** Path plus query, exactly as received. */
  path: string;
  status: number;
  contentType: string | null;
  origin: string | null;
  secFetchMode: string | null;
  /** The Access-Control-Allow-Origin the server answered with. */
  allowOrigin: string | null;
  allowCredentials: string | null;
  /** The body the route handler received (undefined when the request never got that far). */
  body: unknown;
};

export type IngestHarness = {
  publicKey: string;
  /** Where the client posts: http://127.0.0.1:<E2E_INGEST_SERVER_PORT>. */
  ingestOrigin: string;
  /** Where the page lives: http://localhost:<E2E_INGEST_APP_PORT>. A different site. */
  appOrigin: string;
  /** Every request the ingest server finished, in order. */
  hits: IngestHit[];
  /** The client file the app origin serves. */
  clientFile: string;
  /**
   * Make every /ingest/* response answer `Access-Control-Allow-Origin: *` with no
   * Allow-Credentials, as the 90d24af server (and any proxy that rewrites CORS) did.
   */
  setForceWildcard: (on: boolean) => void;
  /**
   * Answer 503 to crash POSTs sent as application/json (the client's fetch path), so the event
   * stays queued for its 30 s retry and is still there at pagehide. text/plain beacons pass.
   */
  setFailCrashFetches: (on: boolean) => void;
  close: () => Promise<void>;
};

// Hand-rolled shapes for the few dist exports used here (see the top comment for why these are
// not imported types).
type HookRequest = { method: string; url: string; raw: IncomingMessage; body?: unknown };
type HookReply = {
  code: (status: number) => HookReply;
  send: (payload?: unknown) => HookReply;
  header: (name: string, value: string) => unknown;
  removeHeader: (name: string) => unknown;
  getHeader: (name: string) => string | number | string[] | undefined;
};
type BuiltServer = {
  server: Server;
  addHook(name: 'preHandler', fn: (req: HookRequest) => Promise<void>): unknown;
  addHook(name: 'onRequest', fn: (req: HookRequest, reply: HookReply) => Promise<unknown>): unknown;
  addHook(
    name: 'onSend',
    fn: (req: HookRequest, reply: HookReply, payload: unknown) => Promise<unknown>,
  ): unknown;
  listen: (opts: { port: number; host: string }) => Promise<string>;
  close: () => Promise<void>;
};
type ServerModule = {
  buildServer: (deps: {
    db: unknown;
    logger: boolean;
    secret: Uint8Array;
    password: string;
  }) => BuiltServer;
};
type DbModule = {
  openDb: (file: string) => { db: unknown; close: () => void };
  applyMigrations: (db: unknown) => void;
};
type ProjectsModule = {
  createProject: (db: unknown, input: { name: string }) => { publicKey: string };
};

const importFrom = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(file).href)) as T;

/** Fails fast when a dist is missing or older than its source, instead of testing stale code. */
const assertBuiltAfter = async (builtFile: string, sources: string[]): Promise<void> => {
  let builtAt: number;
  try {
    builtAt = (await stat(builtFile)).mtimeMs;
  } catch {
    throw new Error(`${builtFile} is missing. Run: ${BUILD_HINT}`);
  }
  for (const src of sources) {
    if ((await stat(src)).mtimeMs > builtAt) {
      throw new Error(`${builtFile} is older than ${src}. Run: ${BUILD_HINT}`);
    }
  }
};

const serverSources = async (srcDir: string): Promise<string[]> =>
  (await readdir(srcDir, { recursive: true }))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(srcDir, f));

const firstHeader = (v: string | string[] | number | undefined): string | null =>
  v === undefined ? null : Array.isArray(v) ? (v[0] ?? null) : String(v);

const appPage = (dsn: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>uh-oh browser ingest e2e</title></head>
<body><h1>app</h1>
<script type="module">
  import * as uhoh from '/uh-oh-client.js';
  uhoh.init({
    dsn: ${JSON.stringify(dsn)},
    release: 'e2e-browser@1.0.0+1',
    debug: true,
    analytics: { auto: true },
  });
  window.uhoh = uhoh;
  window.__uhohReady = true;
</script></body></html>`;

const listen = (server: Server, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });

export const startIngestHarness = async (): Promise<IngestHarness> => {
  const serverDistOverride = process.env['UH_OH_E2E_SERVER_DIST'];
  const clientOverride = process.env['UH_OH_E2E_JS_CLIENT'];
  const serverDist = path.resolve(serverDistOverride ?? path.join(packagesDir, 'server/dist'));
  const clientFile = path.resolve(
    clientOverride ?? path.join(packagesDir, 'js/dist/uh-oh-client.js'),
  );
  if (serverDistOverride === undefined) {
    await assertBuiltAfter(
      path.join(serverDist, 'server.js'),
      await serverSources(path.join(packagesDir, 'server/src')),
    );
  }
  if (clientOverride === undefined) {
    await assertBuiltAfter(clientFile, [path.join(packagesDir, 'js/src/uh-oh-client.ts')]);
  }
  const clientSource = await readFile(clientFile);

  const { buildServer } = await importFrom<ServerModule>(path.join(serverDist, 'server.js'));
  const { openDb, applyMigrations } = await importFrom<DbModule>(
    path.join(serverDist, 'db/index.js'),
  );
  const { createProject } = await importFrom<ProjectsModule>(
    path.join(serverDist, 'db/repos/projects.js'),
  );

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'uh-oh-e2e-ingest-'));
  const { db, close: closeDb } = openDb(path.join(tmpDir, 'ingest.db'));
  applyMigrations(db);
  const { publicKey } = createProject(db, { name: 'browser-ingest-e2e' });

  const ingestOrigin = `http://127.0.0.1:${String(E2E_INGEST_SERVER_PORT)}`;
  const appOrigin = `http://localhost:${String(E2E_INGEST_APP_PORT)}`;
  const hits: IngestHit[] = [];
  const bodies = new WeakMap<IncomingMessage, unknown>();
  // Fastify hands its headers straight to writeHead, so res.getHeader() cannot see them; the
  // onSend hook reads what the reply is about to answer instead.
  const corsAnswers = new WeakMap<
    IncomingMessage,
    Pick<IngestHit, 'allowOrigin' | 'allowCredentials'>
  >();
  let forceWildcard = false;
  let failCrashFetches = false;
  const crashPath = `/ingest/${publicKey}`;

  // Throwaway credentials for a throwaway instance; nothing here authenticates.
  const app = buildServer({
    db,
    logger: false,
    secret: new TextEncoder().encode('uh-oh-e2e-ingest-jwt-secret-at-least-32-chars'),
    password: 'uh-oh-e2e-ingest-admin-password',
  });
  // Added after buildServer's own routes and hooks, before listen(): Fastify composes root hooks
  // into every route at ready time, so these run on the ingest routes too (and the wildcard
  // spec checks the answered header, so a hook that silently did nothing would fail it).
  app.addHook('onRequest', (req, reply) => {
    const contentType = firstHeader(req.raw.headers['content-type']) ?? '';
    if (
      failCrashFetches &&
      req.method === 'POST' &&
      req.url === crashPath &&
      contentType.startsWith('application/json')
    ) {
      // After the server's own CORS hook, so the 503 stays readable to the page.
      return Promise.resolve(reply.code(503).send({ error: 'e2e_unavailable' }));
    }
    return Promise.resolve();
  });
  app.addHook('preHandler', (req) => {
    bodies.set(req.raw, req.body);
    return Promise.resolve();
  });
  app.addHook('onSend', (req, reply, payload) => {
    if (forceWildcard && req.url.startsWith('/ingest/')) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.removeHeader('Access-Control-Allow-Credentials');
    }
    corsAnswers.set(req.raw, {
      allowOrigin: firstHeader(reply.getHeader('access-control-allow-origin')),
      allowCredentials: firstHeader(reply.getHeader('access-control-allow-credentials')),
    });
    return Promise.resolve(payload);
  });
  app.server.prependListener('request', (req: IncomingMessage, res: ServerResponse) => {
    res.once('finish', () => {
      hits.push({
        method: req.method ?? '',
        path: req.url ?? '',
        status: res.statusCode,
        contentType: firstHeader(req.headers['content-type']),
        origin: firstHeader(req.headers['origin']),
        secFetchMode: firstHeader(req.headers['sec-fetch-mode']),
        allowOrigin: corsAnswers.get(req)?.allowOrigin ?? null,
        allowCredentials: corsAnswers.get(req)?.allowCredentials ?? null,
        body: bodies.get(req),
      });
    });
  });

  const html = appPage(`http://${publicKey}@127.0.0.1:${String(E2E_INGEST_SERVER_PORT)}`);
  const serveApp = (req: IncomingMessage, res: ServerResponse): void => {
    const { pathname } = new URL(req.url ?? '/', appOrigin);
    if (pathname === '/uh-oh-client.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(clientSource);
    } else if (pathname === '/app' || pathname === '/other') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pathname === '/app' ? html : '<!doctype html><title>other</title><p>other page');
    } else {
      res.writeHead(404).end();
    }
  };
  // Chrome resolves "localhost" to both loopbacks, so serve both; a machine without IPv6 just
  // uses the IPv4 one.
  const appServers = [http.createServer(serveApp), http.createServer(serveApp)];
  const [appV4, appV6] = appServers as [Server, Server];

  try {
    await app.listen({ port: E2E_INGEST_SERVER_PORT, host: '127.0.0.1' });
    await listen(appV4, E2E_INGEST_APP_PORT, '127.0.0.1');
    await listen(appV6, E2E_INGEST_APP_PORT, '::1').catch(() => undefined);
  } catch (err) {
    await Promise.all(appServers.map(closeServer));
    await app.close().catch(() => undefined);
    closeDb();
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error(
      `browser-ingest harness could not listen on ${String(E2E_INGEST_SERVER_PORT)}/` +
        `${String(E2E_INGEST_APP_PORT)} (a stale e2e process?): ${String(err)}`,
    );
  }

  return {
    publicKey,
    ingestOrigin,
    appOrigin,
    hits,
    clientFile,
    setForceWildcard: (on) => {
      forceWildcard = on;
    },
    setFailCrashFetches: (on) => {
      failCrashFetches = on;
    },
    close: async () => {
      await Promise.all(appServers.map(closeServer));
      await app.close();
      closeDb();
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
};
