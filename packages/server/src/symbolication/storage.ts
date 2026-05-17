import fs from 'node:fs/promises';
import path from 'node:path';

const getSymbolsRoot = (): string =>
  process.env['UH_OH_SYMBOLS_DIR'] ?? path.join(process.cwd(), 'symbols');

export const symbolsDir = (releaseId: string): string => path.join(getSymbolsRoot(), releaseId);

export const mappingPath = (releaseId: string): string =>
  path.join(symbolsDir(releaseId), 'mapping.txt');

export const sourcemapPath = (releaseId: string): string =>
  path.join(symbolsDir(releaseId), 'sourcemap.map');

export const ensureSymbolsDir = (releaseId: string): Promise<void> =>
  fs.mkdir(symbolsDir(releaseId), { recursive: true }).then(() => undefined);
