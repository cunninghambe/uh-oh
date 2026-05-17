import fs from 'node:fs/promises';

import { EventEnvelopeSchema, type StackFrame } from '@uh-oh/types';
import { eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/index.js';
import { getEvent } from '../db/repos/events.js';
import { getReleaseById } from '../db/repos/releases.js';
import { events as eventsTable, symbolications } from '../db/schema.js';
import { mappingPath } from './storage.js';
import { parseProguardMapping } from './proguard.js';

export type SymbolicationStatus = 'ok' | 'no_symbols' | 'unsymbolicated' | 'corrupt_mapping';

export type ResolvedFrame = {
  function?: string;
  module?: string;
  filename?: string;
  lineno?: number;
  status: SymbolicationStatus;
};

// Android Java/Kotlin frames: module looks like a Java class name (dot-separated)
const ANDROID_CLASS_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

const isAndroidFrame = (module: string | undefined): boolean => {
  if (!module) return false;
  return ANDROID_CLASS_RE.test(module);
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

const buildJsFrame = (frame: StackFrame): ResolvedFrame => ({
  // TODO(7c): Hermes source-map symbolication goes here
  ...(frame.module !== undefined ? { module: frame.module } : {}),
  ...(frame.function !== undefined ? { function: frame.function } : {}),
  ...(frame.filename !== undefined ? { filename: frame.filename } : {}),
  ...(frame.lineno !== undefined ? { lineno: frame.lineno } : {}),
  status: 'ok',
});

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

  if (event.releaseId) {
    const release = getReleaseById(db, event.releaseId);
    if (release?.mappingUploadedAt) {
      try {
        const raw = await fs.readFile(mappingPath(event.releaseId), 'utf8');
        proguardMapping = parseProguardMapping(raw);
      } catch {
        mappingCorrupt = true;
      }
    }
  }

  const results: ResolvedFrame[] = [];

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

    const resolved = isAndroidFrame(frame.module)
      ? buildAndroidFrame(frame, proguardMapping, mappingCorrupt)
      : buildJsFrame(frame);

    persistFrame(db, eventId, i, resolved);
    results.push(resolved);
  }

  return results;
};

export const invalidateSymbolications = (db: Db, releaseId: string): void => {
  const eventIds = db
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(eq(eventsTable.releaseId, releaseId))
    .all()
    .map((r) => r.id);

  if (eventIds.length === 0) return;

  db.delete(symbolications).where(inArray(symbolications.eventId, eventIds)).run();
};
