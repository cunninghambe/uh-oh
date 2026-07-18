// Boots the real stack the e2e suite runs against: the actual @uh-oh/server (via
// server-runner.ts — see that file for why it isn't just `node src/index.ts`) against a
// throwaway temp-file SQLite DB, plus `vite build` + `vite preview` for @uh-oh/web with its
// dev-proxy mechanism (vite.config.ts's `server.proxy` / `preview.proxy`, driven by the
// pre-existing UH_OH_SERVER_URL env var) pointed at that server. Playwright's `globalSetup`
// hook: this runs once before any test file, and the async function it returns runs once after
// the whole suite finishes (Playwright's built-in teardown-via-return-value).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  E2E_ADMIN_PASSWORD,
  E2E_JWT_SECRET,
  E2E_SERVER_PORT,
  E2E_SERVER_URL,
  E2E_WEB_PORT,
} from './constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const serverDir = path.resolve(here, '../../server');
const serverRunnerPath = path.join(here, 'server-runner.ts');
const viteBin = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects immediately if something is already listening on `port` — a clearer failure than
 * waiting out the full readiness timeout when e.g. a previous e2e run's server was left running. */
const assertPortFree = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      reject(
        new Error(
          `port ${String(port)} is already in use — is a previous e2e run's process still ` +
            `alive? Kill it and retry.`,
        ),
      );
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(); // connection refused (or similar) — the port is free
    });
  });

const waitForOk = async (url: string, timeoutMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`${url} responded ${String(res.status)}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw new Error(
    `${label} did not become ready within ${String(timeoutMs)}ms (last error: ${String(lastError)})`,
  );
};

/** Tail of a child process's combined stdout+stderr, kept around only to enrich error messages
 * if the process fails to start — not printed otherwise, to keep CI/local logs quiet. */
const captureTail = (child: ChildProcessWithoutNullStreams, maxLines = 60): (() => string) => {
  const lines: string[] = [];
  const push = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      lines.push(line);
      if (lines.length > maxLines) lines.shift();
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  return () => lines.join('\n');
};

const runToCompletion = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...opts, stdio: 'pipe' });
    const tail = captureTail(child);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}\n${tail()}`));
    });
  });

export default async function globalSetup(): Promise<() => Promise<void>> {
  await assertPortFree(E2E_SERVER_PORT);
  await assertPortFree(E2E_WEB_PORT);

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'uh-oh-e2e-'));
  const dbPath = path.join(tmpDir, 'e2e.db');

  const server = spawn('node', ['--import', 'tsx', serverRunnerPath], {
    cwd: serverDir,
    env: {
      ...process.env,
      UH_OH_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
      UH_OH_JWT_SECRET: E2E_JWT_SECRET,
      UH_OH_DB: dbPath,
      UH_OH_PORT: String(E2E_SERVER_PORT),
      UH_OH_HOST: '127.0.0.1',
    },
    stdio: 'pipe',
  });
  const serverTail = captureTail(server);
  let serverExitedEarly = false;
  server.on('exit', () => {
    serverExitedEarly = true;
  });

  try {
    await waitForOk(`http://127.0.0.1:${String(E2E_SERVER_PORT)}/healthz`, 20_000, 'e2e server');
  } catch (err) {
    server.kill();
    throw new Error(`${String(err)}\n--- server output ---\n${serverTail()}`);
  }
  if (serverExitedEarly) {
    throw new Error(`e2e server exited during startup\n--- server output ---\n${serverTail()}`);
  }

  // Build against the current source, then serve that build via `vite preview` — closer to
  // production than `vite dev`, and what the brief asks for.
  await runToCompletion('node', [viteBin, 'build'], { cwd: webDir, env: process.env });

  const preview = spawn(
    'node',
    [viteBin, 'preview', '--port', String(E2E_WEB_PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: webDir,
      env: { ...process.env, UH_OH_SERVER_URL: E2E_SERVER_URL },
      stdio: 'pipe',
    },
  );
  const previewTail = captureTail(preview);
  let previewExitedEarly = false;
  preview.on('exit', () => {
    previewExitedEarly = true;
  });

  try {
    await waitForOk(`http://127.0.0.1:${String(E2E_WEB_PORT)}/`, 20_000, 'e2e web preview');
  } catch (err) {
    server.kill();
    preview.kill();
    throw new Error(`${String(err)}\n--- preview output ---\n${previewTail()}`);
  }
  if (previewExitedEarly) {
    server.kill();
    throw new Error(
      `e2e web preview exited during startup\n--- preview output ---\n${previewTail()}`,
    );
  }

  const killAndWait = (child: ChildProcessWithoutNullStreams): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.kill('SIGTERM');
    });

  return async () => {
    await Promise.all([killAndWait(server), killAndWait(preview)]);
    await rm(tmpDir, { recursive: true, force: true });
  };
}
