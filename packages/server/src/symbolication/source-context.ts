// CONTRACT S — source context extraction. When a JS/web/node frame resolves to
// an original source AND that source's content is embedded in the source map
// (`sourcesContent`), we pull a few lines of surrounding code so an agent (or a
// dashboard) can read the crash site without the repo checked out.
//
// Everything here is deterministic and size-bounded: at most CONTEXT_LINES
// before/after, each line right-trimmed and hard-capped at MAX_LINE_LEN chars
// (tabs inside the line preserved, so indentation survives), and the caller caps
// how many frames get context via MAX_CONTEXT_FRAMES.

import type { BasicSourceMapConsumer, IndexedSourceMapConsumer } from 'source-map';

type Consumer = BasicSourceMapConsumer | IndexedSourceMapConsumer;

/** Surrounding-source snippet for a single resolved frame. */
export type SourceContext = {
  /** Up to CONTEXT_LINES lines immediately before `line` (chronological order). */
  pre: string[];
  /** The crash line itself. */
  line: string;
  /** Up to CONTEXT_LINES lines immediately after `line`. */
  post: string[];
};

// Lines of context on each side of the crash line.
export const CONTEXT_LINES = 5;
// Per-line hard cap (characters). Long minified/vendored lines are truncated.
export const MAX_LINE_LEN = 300;
// Cap on how many (in-app) frames per event carry context — bounds payload size.
export const MAX_CONTEXT_FRAMES = 8;

// Right-trim trailing whitespace (including trailing tabs / CR) then hard-cap the
// length. Leading + interior tabs are preserved so indentation is readable.
const clipLine = (raw: string): string => raw.replace(/\s+$/u, '').slice(0, MAX_LINE_LEN);

/**
 * Extract source context for a resolved position. `source` must be a source as
 * it appears in the map's `sources` (the value `originalPositionFor` returns);
 * `line` is 1-indexed. Returns null when the map carries no embedded content for
 * `source`, when the line is out of range, or on any consumer error.
 */
export const extractContext = (
  consumer: Consumer,
  source: string,
  line: number,
): SourceContext | null => {
  if (!Number.isInteger(line) || line < 1) return null;

  let content: string | null;
  try {
    // `true` => return null instead of throwing when the source is absent.
    content = consumer.sourceContentFor(source, true);
  } catch {
    return null;
  }
  if (content === null || content === undefined) return null;

  const lines = content.split(/\r\n|\r|\n/);
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return null;

  const pre: string[] = [];
  for (let i = Math.max(0, idx - CONTEXT_LINES); i < idx; i++) {
    pre.push(clipLine(lines[i] ?? ''));
  }
  const post: string[] = [];
  for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + CONTEXT_LINES); i++) {
    post.push(clipLine(lines[i] ?? ''));
  }
  return { pre, line: clipLine(lines[idx] ?? ''), post };
};
