import fs from 'node:fs/promises';

import { EventEnvelopeSchema, type StackFrame } from '@uh-oh/types';
import { eq, inArray } from 'drizzle-orm';
import type { BasicSourceMapConsumer, IndexedSourceMapConsumer } from 'source-map';

import type { Db } from '../db/index.js';
import { getEvent } from '../db/repos/events.js';
import { getReleaseById } from '../db/repos/releases.js';
import { events as eventsTable, symbolications } from '../db/schema.js';
import { mappingPath, sourcemapPath } from './storage.js';
import { parseProguardMapping } from './proguard.js';
import { getOrLoadCachedConsumer, invalidateCachedConsumer, resolveJsFrame } from './sourcemap.js';

export type SymbolicationStatus =
  | 'ok'
  | 'no_symbols'
  | 'unsymbolicated'
  | 'corrupt_mapping'
  | 'corrupt_sourcemap';

export type ResolvedFrame = {
  function?: string;
  module?: string;
  filename?: string;
  lineno?: number;
  status: SymbolicationStatus;
};

type Consumer = BasicSourceMapConsumer | IndexedSourceMapConsumer;

const JS_EXTENSIONS_RE = /\.(js|jsx|ts|tsx)$/;
const BUNDLE_NAME_RE = /^index\.android\.bundle$/;
const REMOTE_URL_RE = /^https?:\/\//;

const isJsFrame = (frame: StackFrame): boolean => {
  const filename = frame.filename;
  if (!filename) return false;
  return (
    JS_EXTENSIONS_RE.test(filename) || BUNDLE_NAME_RE.test(filename) || REMOTE_URL_RE.test(filename)
  );
};

const loadCachedFrames = (db: Db, eventId: string): Map<number, ResolvedFrame> => {
  const rows = db.select().from(symbolications).where(eq(symbolications.eventId, eventId)).all();
  const cache = new Map<number, ResolvedFrame>();
  for (const row of rows) {
    cache.set(row.frameIdx, JSON.parse(row.resolved) as ResolvedFrame);
  }
  return cache;
};

const persistFrame = (db: Db, eventId: string, frameIdx: number, resolved: ResolvedFrame): void => {
  db.insert(symbolications)
    .values({ eventId, frameIdx, resolved: JSON.stringify(resolved) })
    .onConflictDoUpdate({
      target: [symbolications.eventId, symbolications.frameIdx],
      set: { resolved: JSON.stringify(resolved) },
    })
    .run();
};

const buildAndroidFrame = (
  frame: StackFrame,
  mapping: ReturnType<typeof parseProguardMapping> | null,
  corrupt: boolean,
): ResolvedFrame => {
  if (corrupt) {
    return {
      ...(frame.module !== undefined ? { module: frame.module } : {}),
      ...(frame.function !== undefined ? { function: frame.function } : {}),
      status: 'corrupt_mapping',
    };
  }
  if (!mapping) {
    return {
      ...(frame.module !== undefined ? { module: frame.module } : {}),
      ...(frame.function !== undefined ? { function: frame.function } : {}),
      status: 'no_symbols',
    };
  }
  const origClass = (frame.module ? mapping.resolveClass(frame.module) : null) ?? frame.module;
  const origMethod =
    frame.module && frame.function
      ? (mapping.resolveMethod(frame.module, frame.function) ?? frame.function)
      : frame.function;

  return {
    ...(origClass !== undefined ? { module: origClass } : {}),
    ...(origMethod !== undefined ? { function: origMethod } : {}),
    ...(frame.lineno !== undefined ? { lineno: frame.lineno } : {}),
    status: 'ok',
  };
};

// jsConsumerState:
//   'none'        — no release linked, return frame as-is (ok, pass-through)
//   'no_symbols'  — release exists but no sourcemap uploaded
//   'corrupt'     — sourcemap uploaded but unreadable/unparseable
//   Consumer      — ready to resolve
type JsConsumerState = 'none' | 'no_symbols' | 'corrupt' | Consumer;

const buildJsFrame = (frame: StackFrame, consumerState: JsConsumerState): ResolvedFrame => {
  if (consumerState === 'none') {
    return {
      ...(frame.module !== undefined ? { module: frame.module } : {}),
      ...(frame.filename !== undefined ? { filename: frame.filename } : {}),
      ...(frame.function !== undefined ? { function: frame.function } : {}),
      ...(frame.lineno !== undefined ? { lineno: frame.lineno } : {}),
      status: 'ok',
    };
  }
  if (consumerState === 'no_symbols') {
    return {
      ...(frame.filename !== undefined ? { filename: frame.filename } : {}),
      ...(frame.function !== undefined ? { function: frame.function } : {}),
      status: 'no_symbols',
    };
  }
  if (consumerState === 'corrupt') {
    return {
      ...(frame.filename !== undefined ? { filename: frame.filename } : {}),
      ...(frame.function !== undefined ? { function: frame.function } : {}),
      status: 'corrupt_sourcemap',
    };
  }
  if (frame.lineno === undefined || frame.colno === undefined) {
    return {
      ...(frame.filename !== undefined ? { filename: frame.filename } : {}),
      ...(frame.function !== undefined ? { function: frame.function } : {}),
      status: 'unsymbolicated',
    };
  }
  const pos = resolveJsFrame(consumerState, { line: frame.lineno, column: frame.colno });
  if (pos.source === null && pos.line === null) {
    return {
      ...(frame.filename !== undefined ? { filename: frame.filename } : {}),
      ...(frame.function !== undefined ? { function: frame.function } : {}),
      status: 'unsymbolicated',
    };
  }
  return {
    ...(pos.source !== null
      ? { filename: pos.source }
      : frame.filename !== undefined
        ? { filename: frame.filename }
        : {}),
    ...(pos.name !== null
      ? { function: pos.name }
      : frame.function !== undefined
        ? { function: frame.function }
        : {}),
    ...(pos.line !== null ? { lineno: pos.line } : {}),
    status: 'ok',
  };
};

export const symbolicateEvent = async (db: Db, eventId: string): Promise<ResolvedFrame[]> => {
  const event = getEvent(db, eventId);
  if (!event) return [];

  const parsed = EventEnvelopeSchema.safeParse(JSON.parse(event.payload));
  if (!parsed.success) return [];

  const frames = parsed.data.exception.stacktrace;
  if (frames.length === 0) return [];

  const cached = loadCachedFrames(db, eventId);
  if (cached.size === frames.length) {
    return frames.map((_, i) => cached.get(i) ?? { status: 'unsymbolicated' });
  }

  let proguardMapping: ReturnType<typeof parseProguardMapping> | null = null;
  let mappingCorrupt = false;
  let jsConsumerState: JsConsumerState = 'none';

  // Snapshot the release's symbol timestamps *before* any async file read, so we
  // can detect a concurrent symbol upload that invalidated the cache mid-flight.
  const releaseId = event.releaseId;
  let mappingAtSnapshot: number | null = null;
  let sourcemapAtSnapshot: number | null = null;

  if (releaseId) {
    const release = getReleaseById(db, releaseId);
    mappingAtSnapshot = release?.mappingUploadedAt ?? null;
    sourcemapAtSnapshot = release?.sourcemapUploadedAt ?? null;

    if (release?.mappingUploadedAt) {
      try {
        const raw = await fs.readFile(mappingPath(releaseId), 'utf8');
        const mapping = parseProguardMapping(raw);
        // Non-empty file that yields zero classes is a corrupt/garbage mapping.
        if (raw.trim().length > 0 && mapping.classCount === 0) {
          mappingCorrupt = true;
        } else {
          proguardMapping = mapping;
        }
      } catch {
        mappingCorrupt = true;
      }
    }
    // Only set no_symbols when there IS a release but no sourcemap uploaded yet.
    // When no release is attached, frames pass through with ok.
    if (release?.sourcemapUploadedAt) {
      try {
        const raw = await fs.readFile(sourcemapPath(releaseId), 'utf8');
        jsConsumerState = await getOrLoadCachedConsumer(releaseId, raw);
      } catch {
        // Sourcemap recorded but unreadable/unparseable → surface as corrupt
        // rather than silently passing frames through as ok.
        jsConsumerState = 'corrupt';
      }
    } else {
      jsConsumerState = 'no_symbols';
    }
  }

  const results: ResolvedFrame[] = [];
  const toPersist: Array<{ idx: number; resolved: ResolvedFrame }> = [];

  for (let i = 0; i < frames.length; i++) {
    const hit = cached.get(i);
    if (hit) {
      results.push(hit);
      continue;
    }

    const frame = frames[i];
    if (!frame) {
      results.push({ status: 'unsymbolicated' });
      continue;
    }

    const resolved = isJsFrame(frame)
      ? buildJsFrame(frame, jsConsumerState)
      : buildAndroidFrame(frame, proguardMapping, mappingCorrupt);

    results.push(resolved);
    toPersist.push({ idx: i, resolved });
  }

  // If a new symbol upload landed while we were symbolicating, the mapping we
  // used is stale — return the results but don't cache them (they'd poison the
  // cache until the next upload).
  if (releaseId && toPersist.length > 0) {
    const fresh = getReleaseById(db, releaseId);
    const stale =
      !fresh ||
      fresh.mappingUploadedAt !== mappingAtSnapshot ||
      fresh.sourcemapUploadedAt !== sourcemapAtSnapshot;
    if (stale) return results;
  }

  for (const p of toPersist) {
    persistFrame(db, eventId, p.idx, p.resolved);
  }

  return results;
};

export const invalidateSymbolications = (db: Db, releaseId: string): void => {
  invalidateCachedConsumer(releaseId);

  // Single statement with a subquery — avoids binding one variable per event id,
  // which blows past SQLite's bound-variable cap for releases with many events.
  db.delete(symbolications)
    .where(
      inArray(
        symbolications.eventId,
        db
          .select({ id: eventsTable.id })
          .from(eventsTable)
          .where(eq(eventsTable.releaseId, releaseId)),
      ),
    )
    .run();
};
