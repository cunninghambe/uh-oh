import type { readConfig } from '../config.js';
import { apiFetch, describeAuthError } from '../client.js';

export type ProjectDeps = {
  config: { read: typeof readConfig };
  fetchFn?: typeof fetch;
  log: (line: string) => void;
};

type ProjectRow = { id: string; slug: string; name: string; publicKey: string; createdAt: number };

// The DSN's host is derived from the stored server URL, not hardcoded:
// strip the scheme, keep everything else (host + port, verbatim) as-is, and
// have the DSN's own scheme mirror whatever scheme the server URL used
// (http for a plain local server, https in production) rather than always
// forcing https.
export const computeDsn = (server: string, publicKey: string): string => {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/.exec(server);
  const scheme = match?.[1] ?? 'https';
  const host = match?.[2] ?? server;
  return `${scheme}://${publicKey}@${host}`;
};

const formatTable = (headers: string[], rows: string[][]): string[] => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const formatRow = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [formatRow(headers), ...rows.map(formatRow)];
};

export const projectList = async (deps: ProjectDeps): Promise<number> => {
  const cfg = await deps.config.read();
  if (!cfg?.token) {
    deps.log('Not logged in — run `uh-oh login`');
    return 2;
  }

  const result = await apiFetch<{ projects: ProjectRow[] }>(
    `${cfg.server}/api/projects`,
    { method: 'GET', token: cfg.token },
    deps.fetchFn,
  );

  if (!result.ok) {
    deps.log(describeAuthError('Error fetching projects', result.error));
    return 2;
  }

  const projects = result.data.projects;
  if (projects.length === 0) {
    deps.log('No projects found');
    return 0;
  }

  const rows = projects.map((p) => [
    p.name,
    p.slug,
    p.publicKey,
    new Date(p.createdAt).toISOString(),
  ]);
  for (const line of formatTable(['name', 'slug', 'publicKey', 'created'], rows)) {
    deps.log(line);
  }
  return 0;
};

export const projectCreate = async (deps: ProjectDeps, args: { name: string }): Promise<number> => {
  const cfg = await deps.config.read();
  if (!cfg?.token) {
    deps.log('Not logged in — run `uh-oh login`');
    return 2;
  }

  const result = await apiFetch<{ project: ProjectRow }>(
    `${cfg.server}/api/projects`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: args.name }),
      token: cfg.token,
    },
    deps.fetchFn,
  );

  if (!result.ok) {
    deps.log(describeAuthError('Error creating project', result.error));
    return 2;
  }

  const project = result.data.project;
  const dsn = computeDsn(cfg.server, project.publicKey);
  deps.log(`Created project ${project.slug}`);
  deps.log(`DSN: ${dsn}`);
  return 0;
};

export const projectDsn = async (deps: ProjectDeps, args: { slug: string }): Promise<number> => {
  const cfg = await deps.config.read();
  if (!cfg?.token) {
    deps.log('Not logged in — run `uh-oh login`');
    return 2;
  }

  const result = await apiFetch<{ projects: ProjectRow[] }>(
    `${cfg.server}/api/projects`,
    { method: 'GET', token: cfg.token },
    deps.fetchFn,
  );

  if (!result.ok) {
    deps.log(describeAuthError('Error fetching projects', result.error));
    return 2;
  }

  const project = result.data.projects.find((p) => p.slug === args.slug);
  if (!project) {
    deps.log(`Project ${args.slug} not found`);
    return 1;
  }

  const dsn = computeDsn(cfg.server, project.publicKey);
  deps.log(dsn);
  deps.log(`UH_OH_DSN=${dsn}`);
  deps.log(`NEXT_PUBLIC_UH_OH_DSN=${dsn}`);
  return 0;
};
