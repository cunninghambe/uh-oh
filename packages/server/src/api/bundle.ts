// CONTRACT B — the issue bundle: everything an agent needs to fix a crash in ONE
// call (project, issue, impact, the latest event fully symbolicated with source
// context + breadcrumbs, a few recent events, symbol availability, and — since
// v0.8 §23 — the investigation record: recent annotations and fix attempts, plus
// the project repo URL).
//
// Deterministic + size-bounded: the serialized bundle is hard-capped at ~64KB.
// When over, we drop content in a fixed order — context lines first, then
// breadcrumbs, then annotations oldest-first (annotations are the most protected
// content) — recording exactly what was dropped in `truncated`. This function is
// the single source of truth, shared by GET /api/issues/:id/bundle and the
// InProcessBackend; the HttpBackend fetches the same route, so every path yields
// an identical bundle.

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
import { listRecentAnnotations, toAnnotationView } from '../db/repos/annotations.js';
import { listFixAttempts, toFixAttemptView } from '../db/repos/fix-attempts.js';
import type { Db } from '../db/index.js';
import { symbolicateEvent } from '../symbolication/symbolicate.js';
import { listWebSymbolMaps } from '../symbolication/web-symbols.js';

/**
 * The server's v0.8 bundle. `IssueBundle` (defined in `@uh-oh/mcp`) now carries
 * every agent-loop addition itself (project.repoUrl, annotations, fixAttempts,
 * truncated.annotations), promoted there from this file's v0.8 draft, so this
 * is a plain alias kept for call-site readability rather than a widening.
 */
export type ServerIssueBundle = IssueBundle;

/** Hard cap on the serialized bundle (~64KB). */
export const BUNDLE_MAX_BYTES = 64 * 1024;
const BREADCRUMB_TAIL = 20;
const RECENT_EVENTS = 3;
/** Newest annotations carried in the bundle. */
const ANNOTATION_TAIL = 10;

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

const byteLength = (bundle: ServerIssueBundle): number =>
  Buffer.byteLength(JSON.stringify(bundle), 'utf8');

/**
 * Shrink `bundle` in place until it fits BUNDLE_MAX_BYTES, in the fixed order:
 * (1) strip source context from the latest event's frames, then (2) drop the
 * latest event's breadcrumbs, then (3) drop annotations oldest-first (they are
 * the most protected content, so they go last and the newest survive longest).
 * Records each step in `bundle.truncated`.
 */
const applyTruncation = (bundle: ServerIssueBundle): void => {
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
    if (byteLength(bundle) <= BUNDLE_MAX_BYTES) return;
  }

  // Annotations are newest-first; drop from the tail (oldest) one at a time until
  // it fits or none remain.
  while (bundle.annotations.length > 0 && byteLength(bundle) > BUNDLE_MAX_BYTES) {
    bundle.annotations.pop();
    bundle.truncated.annotations = true;
  }
};

export const buildIssueBundle = async (
  db: Db,
  issueId: string,
): Promise<ServerIssueBundle | null> => {
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

  // Investigation record (§23): the newest annotations (oldest-first drop order
  // is applied during truncation) and all fix attempts, newest first.
  const annotations = listRecentAnnotations(db, issueId, ANNOTATION_TAIL).map(toAnnotationView);
  const fixAttempts = listFixAttempts(db, issueId).map(toFixAttemptView);

  const bundle: ServerIssueBundle = {
    project: { id: project.id, name: project.name, slug: project.slug, repoUrl: project.repoUrl },
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
    annotations,
    fixAttempts,
    truncated: { context: false, breadcrumbs: false, annotations: false },
  };

  applyTruncation(bundle);
  return bundle;
};
