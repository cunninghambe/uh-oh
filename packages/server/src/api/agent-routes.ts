// CONTRACT A (§23) — the agent-loop write surface plus its read companions.
// POST/GET annotations, POST/PATCH fix attempts, and GET similar issues. The two
// GET routes join the read allowlist (read token / agent token / JWT); the three
// writes are agent-scoped (agent token OR JWT; the read token is rejected).
//
// Every fix-attempt state transition (here and in the ingest regression hook and
// the verify sweep) leaves a kind:'system' annotation as the audit trail.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { buildReadAuthMiddleware } from '../auth/read-token.js';
import { buildAgentAuthMiddleware } from '../auth/agent-token.js';
import { getIssue, setIssueStatus } from '../db/repos/issues.js';
import {
  CLIENT_ANNOTATION_KINDS,
  MAX_ANNOTATION_AUTHOR,
  MAX_ANNOTATION_BODY,
  createAnnotation,
  listAnnotations,
  toAnnotationView,
  writeSystemAnnotation,
  type AnnotationKind,
} from '../db/repos/annotations.js';
import {
  COMMIT_SHA_RE,
  MAX_PR_URL,
  applyFixAttemptTransition,
  getFixAttempt,
  isAllowedClientTransition,
  setFixAttemptCommit,
  toFixAttemptView,
  upsertFixAttempt,
  type FixAttemptState,
} from '../db/repos/fix-attempts.js';
import { similarIssues } from '../db/repos/similar.js';
import { metrics } from '../metrics/registry.js';

const isClientKind = (s: unknown): s is AnnotationKind =>
  typeof s === 'string' && (CLIENT_ANNOTATION_KINDS as readonly string[]).includes(s);

const FIX_STATES: readonly FixAttemptState[] = ['filed', 'deployed', 'verified', 'failed'];
const isFixState = (s: unknown): s is FixAttemptState =>
  typeof s === 'string' && (FIX_STATES as readonly string[]).includes(s);

const clampInt = (raw: unknown, min: number, max: number, dflt: number): number => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

export const registerAgentRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  readToken?: string,
  agentToken?: string,
  now: () => number = () => Date.now(),
): void => {
  const readPreHandler = buildReadAuthMiddleware({ db, secret, readToken, agentToken }) as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  const agentPreHandler = buildAgentAuthMiddleware({ db, secret, agentToken }) as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;

  // ── Annotations ─────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/issues/:id/annotations',
    { preHandler: agentPreHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });

      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const {
        body: text,
        kind,
        author,
      } = body as { body?: unknown; kind?: unknown; author?: unknown };
      if (typeof text !== 'string' || text.length === 0) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      // Body cap is a 413 (payload too large), by bytes.
      if (Buffer.byteLength(text, 'utf8') > MAX_ANNOTATION_BODY) {
        return reply.code(413).send({ error: 'body_too_large' });
      }
      // 'system' is server-only, so it is NOT in CLIENT_ANNOTATION_KINDS → 400.
      if (kind !== undefined && !isClientKind(kind)) {
        return reply.code(400).send({ error: 'invalid_kind' });
      }
      if (
        author !== undefined &&
        (typeof author !== 'string' || author.length > MAX_ANNOTATION_AUTHOR)
      ) {
        return reply.code(400).send({ error: 'invalid_author' });
      }

      const row = createAnnotation(
        db,
        {
          issueId: issue.id,
          body: text,
          ...(kind !== undefined ? { kind } : {}),
          ...(typeof author === 'string' ? { author } : {}),
        },
        now(),
      );
      return reply.code(201).send({ annotation: toAnnotationView(row) });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/issues/:id/annotations',
    { preHandler: readPreHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });
      const limit = clampInt(req.query.limit, 1, 200, 50);
      const offset = clampInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const { rows, total } = listAnnotations(db, issue.id, { limit, offset });
      return { annotations: rows.map(toAnnotationView), total };
    },
  );

  // ── Fix attempts ────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/issues/:id/fix-attempts',
    { preHandler: agentPreHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });

      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const { prUrl, commitSha } = body as { prUrl?: unknown; commitSha?: unknown };
      if (typeof prUrl !== 'string' || prUrl.length === 0 || prUrl.length > MAX_PR_URL) {
        return reply.code(400).send({ error: 'invalid_prUrl' });
      }
      let sha: string | undefined;
      if (commitSha !== undefined) {
        if (typeof commitSha !== 'string' || !COMMIT_SHA_RE.test(commitSha)) {
          return reply.code(400).send({ error: 'invalid_commitSha' });
        }
        sha = commitSha.toLowerCase();
      }

      const { attempt, created } = upsertFixAttempt(
        db,
        { issueId: issue.id, prUrl, ...(sha ? { commitSha: sha } : {}) },
        now(),
      );
      return reply.code(created ? 201 : 200).send({ fixAttempt: toFixAttemptView(attempt) });
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/fix-attempts/:id',
    { preHandler: agentPreHandler },
    (req, reply) => {
      const attempt = getFixAttempt(db, req.params.id);
      if (!attempt) return reply.code(404).send({ error: 'not_found' });

      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const { state, commitSha } = body as { state?: unknown; commitSha?: unknown };

      // Validate a state transition if one was requested. `verified` is never a
      // valid client target (system-set only), so it fails isAllowedClientTransition.
      if (state !== undefined) {
        if (!isFixState(state) || !isAllowedClientTransition(attempt.state, state)) {
          return reply.code(400).send({ error: 'invalid_transition' });
        }
      }
      let sha: string | undefined;
      if (commitSha !== undefined) {
        if (typeof commitSha !== 'string' || !COMMIT_SHA_RE.test(commitSha)) {
          return reply.code(400).send({ error: 'invalid_commitSha' });
        }
        sha = commitSha.toLowerCase();
      }

      const at = now();
      let failed = false;
      db.transaction((tx) => {
        if (state !== undefined && isFixState(state)) {
          applyFixAttemptTransition(tx, attempt, state, at, sha ? { commitSha: sha } : {});
          const note =
            state === 'deployed'
              ? `fix attempt deployed: ${attempt.prUrl} (${attempt.state} -> deployed)`
              : `fix attempt ${state}: ${attempt.prUrl} (${attempt.state} -> ${state})`;
          writeSystemAnnotation(tx, attempt.issueId, note, at);
          if (state === 'deployed') {
            // Re-arm §18 regression detection: resolve the issue if it is live.
            const issue = getIssue(tx, attempt.issueId);
            if (issue && (issue.status === 'open' || issue.status === 'regressed')) {
              setIssueStatus(tx, attempt.issueId, 'resolved');
            }
          }
          if (state === 'failed') failed = true;
        } else if (sha !== undefined) {
          // commitSha-only PATCH: not a state transition, so no system annotation.
          setFixAttemptCommit(tx, attempt.id, sha, at);
        }
      });
      if (failed) metrics.fixFailed.inc();

      const updated = getFixAttempt(db, attempt.id);
      return { fixAttempt: updated ? toFixAttemptView(updated) : null };
    },
  );

  // ── Similar issues ──────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/api/issues/:id/similar',
    { preHandler: readPreHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });
      return { similar: similarIssues(db, issue.id) };
    },
  );
};
