import fs from 'node:fs/promises';
import path from 'node:path';

// Recursively lists every *file* (directories excluded) under `dir`,
// returning paths relative to `dir` using whatever separator this OS's
// fs.readdir produces (path.sep — backslash on Windows, forward slash
// elsewhere). Callers that need a canonical (forward-slash, no-leading-slash)
// path — e.g. to build an upload's `bundlePath` — normalize the separator
// themselves; this module stays a thin, OS-faithful directory listing.
//
// A missing directory (e.g. a Next.js build with no `server/` output because
// it's a fully static export) is not an error here — it just contributes no
// files, so callers don't need special-case handling per subdirectory.
export const listFilesRecursive = async (dir: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
};
