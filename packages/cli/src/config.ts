import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type Config = { server: string; token?: string };

export const configPath = (): string => path.join(os.homedir(), '.config', 'uh-oh', 'config.json');

export const readConfig = async (): Promise<Config | null> => {
  const p = configPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
};

export const writeConfig = async (cfg: Config): Promise<void> => {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  // The `mode` option above only applies when writeFile *creates* a new
  // file; it has no effect if config.json already existed (e.g. from an
  // older CLI version, or a looser umask). chmod explicitly on every write
  // so the token is never left readable by other users. fs.chmod is a
  // permissions no-op on Windows (no POSIX mode bits) and can throw on
  // filesystems that don't support it — swallow that, it's best-effort.
  try {
    await fs.chmod(p, 0o600);
  } catch {
    // best-effort — see comment above
  }
};
