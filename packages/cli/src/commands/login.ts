import readline from 'node:readline';
import type { readConfig, writeConfig } from '../config.js';
import { apiFetch } from '../client.js';

export type LoginDeps = {
  prompt: (q: string, opts?: { hidden?: boolean }) => Promise<string>;
  config: { read: typeof readConfig; write: typeof writeConfig };
  fetchFn?: typeof fetch;
  log: (line: string) => void;
};

export const makePrompt = (q: string, opts?: { hidden?: boolean }): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (opts?.hidden && process.stdin.isTTY) {
      process.stdout.write(q);
      process.stdin.setRawMode(true);
      let answer = '';
      process.stdin.setEncoding('utf8');
      const onData = (ch: string) => {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.stdin.removeListener('data', onData);
          rl.close();
          resolve(answer);
        } else if (ch === '') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.stdin.removeListener('data', onData);
          rl.close();
          process.exit(1);
        } else if (ch === '' || ch === '\b') {
          if (answer.length > 0) answer = answer.slice(0, -1);
        } else {
          answer += ch;
        }
      };
      process.stdin.on('data', onData);
    } else {
      rl.question(q, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });

export const login = async (deps: LoginDeps, args: { server: string }): Promise<number> => {
  // Strip trailing slash(es) so a server URL of "https://x.example.com/"
  // doesn't get persisted and later concatenated into
  // "https://x.example.com//api/projects" by every other command.
  const server = args.server.replace(/\/+$/, '');
  const password = await deps.prompt('Password: ', { hidden: true });

  const result = await apiFetch<{ token: string }>(
    `${server}/api/auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    deps.fetchFn,
  );

  if (!result.ok) {
    if (result.error.kind === 'auth') {
      deps.log('Invalid password');
    } else {
      deps.log(`Error: ${result.error.message}`);
    }
    return 2;
  }

  await deps.config.write({ server, token: result.data.token });
  deps.log(`Logged in to ${server}`);
  return 0;
};
