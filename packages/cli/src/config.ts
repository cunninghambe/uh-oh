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
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
};
