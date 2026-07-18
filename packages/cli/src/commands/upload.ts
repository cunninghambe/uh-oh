import path from 'node:path';
import type { readConfig } from '../config.js';
import { apiFetch } from '../client.js';
import type { ApiError } from '../client.js';

type UploadKind = 'mapping' | 'sourcemap';

export type UploadDeps = {
  config: { read: typeof readConfig };
  fetchFn?: typeof fetch;
  log: (line: string) => void;
  readFile: (path: string) => Promise<Buffer>;
  statFile: (path: string) => Promise<{ size: number }>;
};

type ProjectRow = { id: string; slug: string };
type ReleaseRow = { id: string; version: string; build: string; platform: string };

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — server accepts multipart; see report re: streaming.

const parseRelease = (release: string): { version: string; build: string } | null => {
  const plus = release.lastIndexOf('+');
  if (plus <= 0 || plus === release.length - 1) return null;
  return { version: release.slice(0, plus), build: release.slice(plus + 1) };
};

// A 401/403 on any command almost always means the stored token expired or
// was revoked (logout, JWT secret rotation) — point the user at the fix
// instead of just surfacing the raw server error.
const describeError = (prefix: string, error: ApiError): string =>
  error.kind === 'auth'
    ? `${prefix}: ${error.message} — run \`uh-oh login\` to refresh your token`
    : `${prefix}: ${error.message}`;

export const upload = async (
  deps: UploadDeps,
  kind: UploadKind,
  args: { project: string; release: string; file: string },
): Promise<number> => {
  const cfg = await deps.config.read();
  if (!cfg?.token) {
    deps.log('Not logged in — run `uh-oh login`');
    return 2;
  }

  const parsed = parseRelease(args.release);
  if (!parsed) {
    deps.log('Invalid release format — expected <version>+<build> (e.g. 1.0.0+42)');
    return 1;
  }

  const projectsResult = await apiFetch<{ projects: ProjectRow[] }>(
    `${cfg.server}/api/projects`,
    { method: 'GET', token: cfg.token },
    deps.fetchFn,
  );

  if (!projectsResult.ok) {
    deps.log(describeError('Error fetching projects', projectsResult.error));
    return 2;
  }

  const project = projectsResult.data.projects.find((p) => p.slug === args.project);
  if (!project) {
    deps.log(`Project ${args.project} not found`);
    return 1;
  }

  const releasesResult = await apiFetch<{ releases: ReleaseRow[] }>(
    `${cfg.server}/api/projects/${project.id}/releases`,
    { method: 'GET', token: cfg.token },
    deps.fetchFn,
  );

  if (!releasesResult.ok) {
    deps.log(describeError('Error fetching releases', releasesResult.error));
    return 2;
  }

  const rel = releasesResult.data.releases.find(
    (r) => r.version === parsed.version && r.build === parsed.build && r.platform === 'android',
  );
  if (!rel) {
    deps.log(
      'Release not yet seen by the server — send at least one event from this release first',
    );
    return 1;
  }

  let stat: { size: number };
  try {
    stat = await deps.statFile(args.file);
  } catch {
    deps.log(`Cannot read file: ${args.file}`);
    return 1;
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    deps.log(`File too large: ${args.file} is ${mb} MB — max is 50 MB`);
    return 1;
  }

  // Whole-file read (not streamed) is fine for v0.1: ProGuard mapping files
  // and Hermes source maps are well under the 50 MB cap checked above, and
  // the server accepts multipart, not a streaming upload protocol — a
  // streaming FormData body would be overkill for this size range.
  let fileBuffer: Buffer;
  try {
    fileBuffer = await deps.readFile(args.file);
  } catch {
    deps.log(`Cannot read file: ${args.file}`);
    return 1;
  }

  const form = new FormData();
  // path.basename, not split('/').pop(): the latter passes a Windows path
  // like "C:\Users\dev\mapping.txt" through unmangled since it has no "/",
  // so the server would receive the whole path as the filename.
  form.append('file', new Blob([fileBuffer]), path.basename(args.file) || 'file');
  form.append('platform', 'android');
  if (kind === 'sourcemap') {
    form.append('sourcemap', 'true');
  }

  const uploadResult = await apiFetch<{ release: ReleaseRow }>(
    `${cfg.server}/api/releases/${rel.id}/symbols`,
    { method: 'POST', body: form, token: cfg.token },
    deps.fetchFn,
  );

  if (!uploadResult.ok) {
    deps.log(describeError('Upload failed', uploadResult.error));
    return 2;
  }

  deps.log(`Uploaded ${kind} for ${args.release}`);
  return 0;
};
