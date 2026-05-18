import type { readConfig } from '../config.js';
import { apiFetch } from '../client.js';

type UploadKind = 'mapping' | 'sourcemap';

export type UploadDeps = {
  config: { read: typeof readConfig };
  fetchFn?: typeof fetch;
  log: (line: string) => void;
  readFile: (path: string) => Promise<Buffer>;
};

type ProjectRow = { id: string; slug: string };
type ReleaseRow = { id: string; version: string; build: string; platform: string };

const parseRelease = (release: string): { version: string; build: string } | null => {
  const plus = release.lastIndexOf('+');
  if (plus <= 0 || plus === release.length - 1) return null;
  return { version: release.slice(0, plus), build: release.slice(plus + 1) };
};

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
    deps.log(`Error fetching projects: ${projectsResult.error.message}`);
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
    deps.log(`Error fetching releases: ${releasesResult.error.message}`);
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

  let fileBuffer: Buffer;
  try {
    fileBuffer = await deps.readFile(args.file);
  } catch {
    deps.log(`Cannot read file: ${args.file}`);
    return 1;
  }

  const form = new FormData();
  form.append('file', new Blob([fileBuffer]), args.file.split('/').pop() ?? 'file');
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
    deps.log(`Upload failed: ${uploadResult.error.message}`);
    return 2;
  }

  deps.log(`Uploaded ${kind} for ${args.release}`);
  return 0;
};
