// CONTRACT B — the issue bundle: everything an agent needs to fix a crash in ONE
// call (project, issue, impact, the latest event fully symbolicated with source
// context + breadcrumbs, a few recent events, and symbol availability).
//
// Deterministic + size-bounded: the serialized bundle is hard-capped at ~64KB.
// When over, we drop context lines first, then breadcrumbs, recording exactly
// what was dropped in `truncated`. This function is the single source of truth,
// shared by GET /api/issues/:id/bundle and the InProcessBackend; the HttpBackend
// fetches the same route, so every path yields an identical bundle.

import type {
  BundleBreadcrumb,
  BundleFrame,
  BundleLatestEvent,
  BundleRecentEvent,
  BundleSymbols,
  IssueBundle,
} from '@uh-oh/mcp';

import { listBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { getLatestEventForIssue, listEventsForIssue } from '../db/repos/events.js';
import { computeImpact } from '../db/repos/impact.js';
import { getIssue } from '../db/repos/issues.js';
import { getProjectById } from '../db/repos/projects.js';
import { getReleaseById } from '../db/repos/releases.js';
import type { Db } from '../db/index.js';
import { symbolicateEvent } from '../symbolication/symbolicate.js';
import { listWebSymbolMaps } from '../symbolication/web-symbols.js';

/** Hard cap on the serialized bundle (~64KB). */
export const BUNDLE_MAX_BYTES = 64 * 1024;
const BREADCRUMB_TAIL = 20;
const RECENT_EVENTS = 3;

type ParsedPayload = {
  release?: { version?: unknown; build?: unknown };
  exception?: { type?: unknown; value?: unknown; mechanism?: unknown };
};

const parsePayload = (payload: string): ParsedPayload => {
  try {
    const v: unknown = JSON.parse(payload);
    return v && typeof v === 'object' ? (v as ParsedPayload) : {};
  } catch {
    return {};
  }
};

/** "version+build" label from a payload, or null when either is missing. */
const releaseLabel = (payload: string): string | null => {
  const rel = parsePayload(payload).release;
  const v = rel?.version;
  const b = rel?.build;
  return typeof v === 'string' && typeof b === 'string' ? `${v}+${b}` : null;
};

const parseCrumbData = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

const byteLength = (bundle: IssueBundle): number =>
  Buffer.byteLength(JSON.stringify(bundle), 'utf8');

/**
 * Shrink `bundle` in place until it fits BUNDLE_MAX_BYTES, in the fixed order:
 * (1) strip source context from the latest event's frames, then (2) drop the
 * latest event's breadcrumbs. Records each step in `bundle.truncated`.
 */
const applyTruncation = (bundle: IssueBundle): void => {
  if (byteLength(bundle) <= BUNDLE_MAX_BYTES) return;

  const latest = bundle.latestEvent;
  if (latest) {
    let dropped = false;
    latest.frames = latest.frames.map((f) => {
      if (f.context === undefined) return f;
      dropped = true;
      const { context: _drop, ...rest } = f;
      return rest;
    });
    if (dropped) bundle.truncated.context = true;
    if (byteLength(bundle) <= BUNDLE_MAX_BYTES) return;

    if (latest.breadcrumbs.length > 0) {
      latest.breadcrumbs = [];
      bundle.truncated.breadcrumbs = true;
    }
  }
};

export const buildIssueBundle = async (db: Db, issueId: string): Promise<IssueBundle | null> => {
  const issue = getIssue(db, issueId);
  if (!issue) return null;
  const project = getProjectById(db, issue.projectId);
  if (!project) return null;

  const impact = computeImpact(db, issueId);

  const latest = getLatestEventForIssue(db, issueId);
  let latestEvent: BundleLatestEvent | null = null;
  let symbols: BundleSymbols | null = null;

  if (latest) {
    const env = parsePayload(latest.payload);
    const frames: BundleFrame[] = await symbolicateEvent(db, latest.id);

    const crumbs = listBreadcrumbs(db, latest.id);
    const tail =
      crumbs.length > BREADCRUMB_TAIL ? crumbs.slice(crumbs.length - BREADCRUMB_TAIL) : crumbs;
    const breadcrumbs: BundleBreadcrumb[] = tail.map((b) => ({
      ts: b.ts,
      category: b.category,
      level: b.level,
      message: b.message,
      ...(b.data != null ? { data: parseCrumbData(b.data) } : {}),
    }));

    const ex = env.exception;
    latestEvent = {
      id: latest.id,
      receivedAt: latest.receivedAt,
      level: latest.level,
      platform: latest.platform,
      release: releaseLabel(latest.payload),
      exception: ex
        ? {
            ...(typeof ex.type === 'string' ? { type: ex.type } : {}),
            ...(typeof ex.value === 'string' ? { value: ex.value } : {}),
            ...(typeof ex.mechanism === 'string' ? { mechanism: ex.mechanism } : {}),
          }
        : null,
      frames,
      breadcrumbs,
    };

    if (latest.releaseId) {
      const release = getReleaseById(db, latest.releaseId);
      if (release) {
        const maps = await listWebSymbolMaps(release.id);
        symbols = {
          releaseId: release.id,
          platform: release.platform,
          mappingUploaded: release.mappingUploadedAt != null,
          sourcemapUploaded: release.sourcemapUploadedAt != null,
          maps: {
            web: maps.filter((m) => m.platform === 'web').length,
            node: maps.filter((m) => m.platform === 'node').length,
          },
        };
      }
    }
  }

  const recentEvents: BundleRecentEvent[] = listEventsForIssue(db, issueId, {
    limit: RECENT_EVENTS,
  }).rows.map((e) => ({
    id: e.id,
    receivedAt: e.receivedAt,
    level: e.level,
    platform: e.platform,
    release: releaseLabel(e.payload),
  }));

  const bundle: IssueBundle = {
    project: { id: project.id, name: project.name, slug: project.slug },
    issue: {
      id: issue.id,
      title: issue.title,
      fingerprint: issue.fingerprint,
      platform: issue.platform,
      status: issue.status,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      eventCount: issue.eventCount,
    },
    impact,
    latestEvent,
    recentEvents,
    symbols,
    truncated: { context: false, breadcrumbs: false },
  };

  applyTruncation(bundle);
  return bundle;
};
