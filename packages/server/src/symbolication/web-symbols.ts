import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { platformSymbolsDir } from './storage.js';

// Web/node platforms that accept per-bundle source maps.
export type WebPlatform = 'web' | 'node';
export const WEB_PLATFORMS: readonly WebPlatform[] = ['web', 'node'];

export const isWebPlatform = (p: string): p is WebPlatform => p === 'web' || p === 'node';

const MAX_BUNDLE_PATH_LEN = 512;
const MAP_SUFFIX = '.map';

// Reject NUL and any C0 control character (code point < 0x20) in a path segment.
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
};

export type SanitizeResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'empty' | 'too_long' | 'absolute' | 'traversal' | 'invalid_char' };

/**
 * Sanitize a client-supplied `bundlePath` (the JS file's path relative to the
 * app build, e.g. `static/chunks/4bd1b696.js`). SECURITY-CRITICAL: the result is
 * used to build an on-disk path under the release's symbols dir, so this must
 * reject anything that could escape it.
 *
 * Rules:
 *  - length cap 512 (on the raw input);
 *  - backslashes are normalized to forward slashes;
 *  - absolute paths (POSIX root `/...` or Windows drive `C:...`) are rejected;
 *  - any `..` segment is rejected (no traversal);
 *  - NUL / control characters are rejected;
 *  - `.` and empty segments (from `//`, leading/trailing slashes) are collapsed.
 *
 * Returns the normalized forward-slash relative path on success.
 */
export const sanitizeBundlePath = (raw: unknown): SanitizeResult => {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  if (raw.length > MAX_BUNDLE_PATH_LEN) return { ok: false, reason: 'too_long' };

  // Normalize backslashes so a Windows-style path can't smuggle a separator past
  // the segment checks below.
  const normalized = raw.replace(/\\/g, '/');

  // Reject absolute paths: POSIX root and Windows drive-letter roots.
  if (normalized.startsWith('/')) return { ok: false, reason: 'absolute' };
  if (/^[A-Za-z]:/.test(normalized)) return { ok: false, reason: 'absolute' };

  const clean: string[] = [];
  for (const seg of normalized.split('/')) {
    if (seg === '' || seg === '.') continue; // collapse `//`, leading/trailing `/`, `./`
    if (seg === '..') return { ok: false, reason: 'traversal' };
    if (hasControlChar(seg)) return { ok: false, reason: 'invalid_char' };
    clean.push(seg);
  }
  if (clean.length === 0) return { ok: false, reason: 'empty' };

  return { ok: true, path: clean.join('/') };
};

/**
 * Is `child` contained within `parent` (defense-in-depth on top of
 * sanitizeBundlePath — the storage layer never writes outside the platform dir).
 */
export const isUnderDir = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** On-disk path for a web/node per-bundle source map (`<...>/<bundlePath>.map`). */
export const webSymbolMapPath = (
  releaseId: string,
  platform: WebPlatform,
  sanitizedBundlePath: string,
): string =>
  path.join(platformSymbolsDir(releaseId, platform), ...sanitizedBundlePath.split('/')) +
  MAP_SUFFIX;

export const readWebSymbolMap = (
  releaseId: string,
  platform: WebPlatform,
  sanitizedBundlePath: string,
): Promise<string> =>
  fs.readFile(webSymbolMapPath(releaseId, platform, sanitizedBundlePath), 'utf8');

const walkFiles = async (dir: string): Promise<string[]> => {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs)));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
};

export type WebSymbolMapInfo = { platform: WebPlatform; bundlePath: string; size: number };

/**
 * List every uploaded web/node source map for a release. bundlePath is the
 * sanitized, forward-slash relative path (the `.map` suffix stripped).
 */
export const listWebSymbolMaps = async (releaseId: string): Promise<WebSymbolMapInfo[]> => {
  const result: WebSymbolMapInfo[] = [];
  for (const platform of WEB_PLATFORMS) {
    const dir = platformSymbolsDir(releaseId, platform);
    const files = await walkFiles(dir);
    for (const abs of files) {
      if (!abs.endsWith(MAP_SUFFIX)) continue;
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      const bundlePath = rel.slice(0, -MAP_SUFFIX.length);
      if (bundlePath.length === 0) continue;
      const stat = await fs.stat(abs);
      result.push({ platform, bundlePath, size: stat.size });
    }
  }
  return result;
};

/** Bundle paths for a single platform (used by symbolication for suffix matching). */
export const listBundlePathsForPlatform = async (
  releaseId: string,
  platform: WebPlatform,
): Promise<string[]> => {
  const maps = await listWebSymbolMaps(releaseId);
  return maps.filter((m) => m.platform === platform).map((m) => m.bundlePath);
};

/**
 * Extract the path component of a stack-frame `filename`. Handles the three
 * shapes web/node frames arrive in:
 *   - a full URL  `https://host/_next/static/chunks/x.js` -> `/_next/static/chunks/x.js`
 *   - a bare path `/_next/static/chunks/x.js`             -> unchanged
 *   - a file URL  `file:///app/.next/server/x.js`         -> `/app/.next/server/x.js`
 */
export const extractPathComponent = (filename: string): string => {
  if (/^(?:https?|file):\/\//i.test(filename)) {
    try {
      return decodeURIComponent(new URL(filename).pathname);
    } catch {
      // Fall through: treat as a plain path.
    }
  }
  return filename;
};

const toSegments = (p: string): string[] =>
  p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');

/**
 * Match a frame `filename` against stored bundlePaths by LONGEST SUFFIX MATCH on
 * the path component: a bundlePath matches when its trailing path segments are a
 * suffix of the frame's segments. The bundlePath with the most matching trailing
 * segments wins (ties broken by longer string). Returns the matched bundlePath,
 * or null when nothing matches.
 */
export const matchBundlePath = (filename: string, bundlePaths: string[]): string | null => {
  const frameSegs = toSegments(extractPathComponent(filename));
  if (frameSegs.length === 0) return null;

  let best: string | null = null;
  let bestSegs = 0;
  let bestLen = 0;

  for (const bp of bundlePaths) {
    const bpSegs = toSegments(bp);
    if (bpSegs.length === 0 || bpSegs.length > frameSegs.length) continue;

    let matches = true;
    for (let i = 1; i <= bpSegs.length; i++) {
      if (frameSegs[frameSegs.length - i] !== bpSegs[bpSegs.length - i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    if (bpSegs.length > bestSegs || (bpSegs.length === bestSegs && bp.length > bestLen)) {
      best = bp;
      bestSegs = bpSegs.length;
      bestLen = bp.length;
    }
  }
  return best;
};
