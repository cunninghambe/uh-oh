import path from 'node:path';
import type { readConfig } from '../config.js';
import { apiFetch, describeAuthError } from '../client.js';

type UploadKind = 'mapping' | 'sourcemap';
// Web/node uploads are the Next.js escape-hatch surface (§ CONTRACT); mapping
// and plain hermes sourcemap uploads stay on the original android-only path.
type UploadPlatform = 'web' | 'node';

export type UploadDeps = {
  config: { read: typeof readConfig };
  fetchFn?: typeof fetch;
  log: (line: string) => void;
  readFile: (path: string) => Promise<Buffer>;
  statFile: (path: string) => Promise<{ size: number }>;
};

type ProjectRow = { id: string; slug: string };
type ReleaseRow = { id: string; version: string; build: string; platform: string };

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — server accepts multipart; see report re: streaming.

export const parseRelease = (release: string): { version: string; build: string } | null => {
  const plus = release.lastIndexOf('+');
  if (plus <= 0 || plus === release.length - 1) return null;
  return { version: release.slice(0, plus), build: release.slice(plus + 1) };
};

export const upload = async (
  deps: UploadDeps,
  kind: UploadKind,
  args: {
    project: string;
    release: string;
    file: string;
    platform?: UploadPlatform;
    bundlePath?: string;
  },
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
    deps.log(describeAuthError('Error fetching projects', projectsResult.error));
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
    deps.log(describeAuthError('Error fetching releases', releasesResult.error));
    return 2;
  }

  // Release rows are scoped per-platform (schema: unique on project+version+build+platform), so
  // the lookup platform must track what we're about to upload, not stay hardcoded to 'android'.
  // Only `upload sourcemap` exposes --platform; mapping uploads and hermes sourcemaps (the
  // pre-existing behavior, --platform omitted) always resolve against the 'android' release.
  const effectivePlatform: string =
    kind === 'sourcemap' && args.platform ? args.platform : 'android';

  let rel = releasesResult.data.releases.find(
    (r) =>
      r.version === parsed.version && r.build === parsed.build && r.platform === effectivePlatform,
  );

  // Web/node CONTRACT flow only (`upload sourcemap --platform`): source-map
  // uploads run in deploy pipelines BEFORE the first crash event of a release,
  // so a missing row is normal — create it via the idempotent upsert
  // (POST /api/projects/:id/releases → 201 created / 200 existing). The legacy
  // android flows keep requiring a device-seen release, unchanged.
  if (!rel && kind === 'sourcemap' && args.platform) {
    const createdResult = await apiFetch<{ release: ReleaseRow }>(
      `${cfg.server}/api/projects/${project.id}/releases`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: parsed.version,
          build: parsed.build,
          platform: effectivePlatform,
        }),
        token: cfg.token,
      },
      deps.fetchFn,
    );
    if (!createdResult.ok) {
      deps.log(
        describeAuthError(
          `Could not create release ${args.release} for platform ${effectivePlatform}`,
          createdResult.error,
        ),
      );
      return 2;
    }
    deps.log(`Created release ${args.release} for platform ${effectivePlatform}`);
    rel = createdResult.data.release;
  }

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
  form.append('platform', effectivePlatform);
  if (kind === 'sourcemap' && !args.platform) {
    // Legacy hermes flow (no --platform given): keep sending the sourcemap
    // marker exactly as before. The web/node CONTRACT fields (platform +
    // bundlePath) replace this marker when --platform is explicitly used.
    form.append('sourcemap', 'true');
  }
  if (args.bundlePath) {
    form.append('bundlePath', args.bundlePath);
  }

  const uploadResult = await apiFetch<{ release: ReleaseRow }>(
    `${cfg.server}/api/releases/${rel.id}/symbols`,
    { method: 'POST', body: form, token: cfg.token },
    deps.fetchFn,
  );

  if (!uploadResult.ok) {
    deps.log(describeAuthError('Upload failed', uploadResult.error));
    return 2;
  }

  deps.log(`Uploaded ${kind} for ${args.release}`);
  return 0;
};
