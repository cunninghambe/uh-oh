import path from 'node:path';
import type { readConfig } from '../config.js';
import { apiFetch, describeAuthError } from '../client.js';
import { parseRelease, MAX_UPLOAD_BYTES } from './upload.js';

export type NextSourcemapsDeps = {
  config: { read: typeof readConfig };
  fetchFn?: typeof fetch;
  log: (line: string) => void;
  readFile: (path: string) => Promise<Buffer>;
  statFile: (path: string) => Promise<{ size: number }>;
  // Lists files recursively under `dir`, relative to `dir`. Must resolve to
  // [] (not reject) when `dir` does not exist — a Next.js static export has
  // no `server/` output, and that's a normal, zero-file case, not an error.
  listFiles: (dir: string) => Promise<string[]>;
};

type ProjectRow = { id: string; slug: string };
type ReleaseRow = { id: string; version: string; build: string; platform: string };

type MapPlatform = 'web' | 'node';

type MapCandidate = {
  platform: MapPlatform;
  absPath: string;
  // Forward-slash, no leading slash, no `..` — path of the JS file relative
  // to the app build (the CONTRACT's `bundlePath` field), e.g.
  // "static/chunks/123.js" or "server/pages/index.js".
  bundlePath: string;
};

// subdir is both the on-disk folder name under `<dir>` *and* the bundlePath
// prefix — "static/..." for browser bundles, "server/..." for server bundles.
const findMapCandidates = async (
  listFiles: NextSourcemapsDeps['listFiles'],
  baseDir: string,
  subdir: 'static' | 'server',
  platform: MapPlatform,
): Promise<MapCandidate[]> => {
  const root = path.join(baseDir, subdir);
  const relPaths = await listFiles(root);
  return relPaths
    .filter((p) => p.endsWith('.js.map'))
    .map((relPath) => {
      // Normalize to forward slashes regardless of the host OS or of what
      // separator style the injected listFiles used — the bundlePath the
      // server stores must be POSIX-style per the CONTRACT.
      const posixRel = relPath
        .split(path.sep)
        .join('/')
        .replace(/\.map$/, '');
      return {
        platform,
        absPath: path.join(root, relPath),
        bundlePath: `${subdir}/${posixRel}`,
      };
    });
};

const uploadOne = async (
  deps: NextSourcemapsDeps,
  server: string,
  token: string,
  releaseId: string,
  item: MapCandidate,
): Promise<{ ok: true } | { ok: false; skipped: boolean; message: string }> => {
  let stat: { size: number };
  try {
    stat = await deps.statFile(item.absPath);
  } catch {
    return { ok: false, skipped: false, message: `Cannot read file: ${item.absPath}` };
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      skipped: true,
      message: `Skipping ${item.bundlePath}: ${mb} MB exceeds the 50 MB cap`,
    };
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = await deps.readFile(item.absPath);
  } catch {
    return { ok: false, skipped: false, message: `Cannot read file: ${item.absPath}` };
  }

  const form = new FormData();
  form.append('file', new Blob([fileBuffer]), path.basename(item.absPath));
  form.append('platform', item.platform);
  form.append('bundlePath', item.bundlePath);

  const result = await apiFetch<{ release: ReleaseRow }>(
    `${server}/api/releases/${releaseId}/symbols`,
    { method: 'POST', body: form, token },
    deps.fetchFn,
  );

  if (!result.ok) {
    return {
      ok: false,
      skipped: false,
      message: describeAuthError(`Upload failed for ${item.bundlePath}`, result.error),
    };
  }
  return { ok: true };
};

export const uploadNextSourcemaps = async (
  deps: NextSourcemapsDeps,
  args: { project: string; release: string; dir: string; dryRun?: boolean },
): Promise<number> => {
  const parsed = parseRelease(args.release);
  if (!parsed) {
    deps.log('Invalid release format — expected <version>+<build> (e.g. 1.0.0+42)');
    return 1;
  }

  const webCandidates = await findMapCandidates(deps.listFiles, args.dir, 'static', 'web');
  const nodeCandidates = await findMapCandidates(deps.listFiles, args.dir, 'server', 'node');
  const all = [...webCandidates, ...nodeCandidates];

  if (all.length === 0) {
    deps.log(`No source maps found under ${args.dir}`);
    return 0;
  }

  if (args.dryRun) {
    // No network calls (no login/project/release lookup) — but file size is
    // local information, so we still surface the 50 MB skip warning here to
    // keep the preview honest about what a real run would do.
    let dryWeb = 0;
    let dryNode = 0;
    let drySkipped = 0;
    for (const item of all) {
      let size: number | undefined;
      try {
        size = (await deps.statFile(item.absPath)).size;
      } catch {
        deps.log(`Cannot read file: ${item.absPath}`);
        continue;
      }
      if (size > MAX_UPLOAD_BYTES) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        deps.log(`Skipping ${item.bundlePath}: ${mb} MB exceeds the 50 MB cap`);
        drySkipped++;
        continue;
      }
      deps.log(`[dry-run] ${item.platform} ${item.bundlePath}`);
      if (item.platform === 'web') dryWeb++;
      else dryNode++;
    }
    deps.log(`would upload ${dryWeb} web + ${dryNode} node maps (${drySkipped} skipped)`);
    return 0;
  }

  const cfg = await deps.config.read();
  if (!cfg?.token) {
    deps.log('Not logged in — run `uh-oh login`');
    return 2;
  }
  const { server, token } = cfg;

  const projectsResult = await apiFetch<{ projects: ProjectRow[] }>(
    `${server}/api/projects`,
    { method: 'GET', token },
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
    `${server}/api/projects/${project.id}/releases`,
    { method: 'GET', token },
    deps.fetchFn,
  );
  if (!releasesResult.ok) {
    deps.log(describeAuthError('Error fetching releases', releasesResult.error));
    return 2;
  }

  // Resolves the per-platform release row, creating it via the idempotent
  // upsert (POST /api/projects/:id/releases → 201 created / 200 existing) when
  // the list does not have it yet — source-map uploads normally run in the
  // deploy pipeline BEFORE the first crash event of the release exists.
  const resolveRelease = async (platform: MapPlatform): Promise<ReleaseRow | undefined> => {
    const existing = releasesResult.data.releases.find(
      (r) => r.version === parsed.version && r.build === parsed.build && r.platform === platform,
    );
    if (existing) return existing;

    const createdResult = await apiFetch<{ release: ReleaseRow }>(
      `${server}/api/projects/${project.id}/releases`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: parsed.version, build: parsed.build, platform }),
        token,
      },
      deps.fetchFn,
    );
    if (!createdResult.ok) {
      deps.log(
        describeAuthError(
          `Could not create release ${args.release} for platform ${platform}`,
          createdResult.error,
        ),
      );
      return undefined;
    }
    deps.log(`Created release ${args.release} for platform ${platform}`);
    return createdResult.data.release;
  };

  const webRelease = webCandidates.length > 0 ? await resolveRelease('web') : undefined;
  const nodeRelease = nodeCandidates.length > 0 ? await resolveRelease('node') : undefined;

  let failed = 0;
  if (webCandidates.length > 0 && !webRelease) failed += webCandidates.length;
  if (nodeCandidates.length > 0 && !nodeRelease) failed += nodeCandidates.length;

  const uploadable: Array<MapCandidate & { releaseId: string }> = [
    ...(webRelease ? webCandidates.map((c) => ({ ...c, releaseId: webRelease.id })) : []),
    ...(nodeRelease ? nodeCandidates.map((c) => ({ ...c, releaseId: nodeRelease.id })) : []),
  ];

  let uploadedWeb = 0;
  let uploadedNode = 0;
  let skipped = 0;

  for (let i = 0; i < uploadable.length; i++) {
    const item = uploadable[i];
    if (!item) continue;
    deps.log(`[${i + 1}/${uploadable.length}] ${item.platform} ${item.bundlePath}`);

    const result = await uploadOne(deps, server, token, item.releaseId, item);
    if (!result.ok) {
      deps.log(result.message);
      if (result.skipped) {
        skipped++;
      } else {
        failed++;
      }
      continue;
    }

    if (item.platform === 'web') uploadedWeb++;
    else uploadedNode++;
  }

  deps.log(`uploaded ${uploadedWeb} web + ${uploadedNode} node maps (${skipped} skipped)`);
  return failed > 0 ? 1 : 0;
};
