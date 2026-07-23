import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { ApiError, type Release, api } from '../api.js';
import { CommitLink } from '../components/CommitLink.js';
import {
  EAGER_MAP_COUNT_THRESHOLD,
  formatMapCounts,
  oversizeError,
  summarizeMapCounts,
} from './Releases.utils.js';

type UploadState = 'idle' | 'uploading' | 'done' | 'error';

type RowUploadStatus = {
  mapping: UploadState;
  sourcemap: UploadState;
  mappingProgress: number;
  sourcemapProgress: number;
  mappingError: string | null;
  sourcemapError: string | null;
};

const formatTs = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleString());

const UploadCell = ({
  label,
  state,
  progress,
  errorMsg,
  inputRef,
  onChange,
}: {
  label: string;
  state: UploadState;
  progress: number;
  errorMsg: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (file: File) => void;
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const busy = state === 'uploading';

  return (
    <div
      className={`space-y-1 rounded border border-dashed px-2 py-1.5 transition-colors ${
        isDragOver ? 'border-amber-500 bg-amber-950/20' : 'border-zinc-700'
      }`}
      onDragOver={(e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (!busy) setIsDragOver(true);
      }}
      onDragLeave={() => {
        setIsDragOver(false);
      }}
      onDrop={(e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
        if (busy) return;
        const file = e.dataTransfer.files[0];
        if (file) onChange(file);
      }}
    >
      <label className="block text-xs text-zinc-500">{label} — drag & drop or choose file</label>
      <input
        ref={inputRef}
        type="file"
        accept={label === 'Mapping' ? '.txt,text/plain' : '.map,application/json'}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          if (file) onChange(file);
        }}
        disabled={busy}
        className="block text-xs text-zinc-400 file:mr-2 file:rounded file:border-0 file:bg-zinc-700 file:px-2 file:py-1 file:text-xs file:text-zinc-200 hover:file:bg-zinc-600 disabled:opacity-50"
      />
      {busy && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-amber-500 transition-all"
              style={{ width: `${String(progress)}%` }}
            />
          </div>
          <span className="text-xs text-zinc-500">Uploading… {progress}%</span>
        </div>
      )}
      {state === 'done' && <span className="text-xs text-emerald-400">Uploaded</span>}
      {state === 'error' && (
        <span className="text-xs text-red-400">{errorMsg ?? 'Upload failed'}</span>
      )}
    </div>
  );
};

// v0.4 item 2: compact "N web maps · M node maps" summary for a release, from GET
// /api/releases/:id/symbols (v0.3). `eager` rows fetch on mount; the rest fetch lazily on
// hover/focus (see EAGER_MAP_COUNT_THRESHOLD in Releases.utils.ts for the split rationale). A
// 404 (unknown/deleted release) or any other error is treated the same as "nothing uploaded
// yet" — nothing is rendered, no error state.
const ReleaseMapsCount = ({ releaseId, eager }: { releaseId: string; eager: boolean }) => {
  const [active, setActive] = useState(eager);
  const mapsQ = useQuery({
    queryKey: ['release-symbols', releaseId],
    queryFn: () => api.getReleaseSymbols(releaseId),
    enabled: active,
    retry: false,
  });

  const label = mapsQ.data ? formatMapCounts(summarizeMapCounts(mapsQ.data.maps)) : '';
  if (label) return <span className="text-xs text-zinc-500">{label}</span>;
  if (active) return null; // loading, empty, or errored — nothing to show (yet or ever)

  // Not activated yet (long list, row untouched): a quiet hover/focus target rather than an
  // eager fetch, so opening a project with hundreds of releases doesn't fan out hundreds of
  // requests on load.
  return (
    <button
      type="button"
      onMouseEnter={() => {
        setActive(true);
      }}
      onFocus={() => {
        setActive(true);
      }}
      className="text-xs text-zinc-600 underline decoration-dotted hover:text-zinc-400"
    >
      Maps…
    </button>
  );
};

const ReleaseRow = ({
  release,
  eagerMaps,
  onUploadDone,
  repoUrl,
}: {
  release: Release;
  eagerMaps: boolean;
  onUploadDone: () => void;
  repoUrl: string | null | undefined;
}) => {
  const [status, setStatus] = useState<RowUploadStatus>({
    mapping: 'idle',
    sourcemap: 'idle',
    mappingProgress: 0,
    sourcemapProgress: 0,
    mappingError: null,
    sourcemapError: null,
  });
  const mappingRef = useRef<HTMLInputElement | null>(null);
  const sourcemapRef = useRef<HTMLInputElement | null>(null);

  const upload = (file: File, isSourcemap: boolean): void => {
    const key = isSourcemap ? 'sourcemap' : 'mapping';
    const errKey = isSourcemap ? 'sourcemapError' : 'mappingError';
    const progressKey = isSourcemap ? 'sourcemapProgress' : 'mappingProgress';

    // Client-side size pre-check against the server's cap — fail fast, no network call.
    const sizeError = oversizeError(file.size);
    if (sizeError) {
      setStatus((s) => ({ ...s, [key]: 'error', [errKey]: sizeError }));
      return;
    }

    setStatus((s) => ({ ...s, [key]: 'uploading', [errKey]: null, [progressKey]: 0 }));
    api
      .uploadSymbols(release.id, file, {
        sourcemap: isSourcemap,
        onProgress: (percent) => {
          setStatus((s) => ({ ...s, [progressKey]: percent }));
        },
      })
      .then(() => {
        setStatus((s) => ({ ...s, [key]: 'done', [progressKey]: 100 }));
        onUploadDone();
      })
      .catch((err: unknown) => {
        const msg = err instanceof ApiError ? err.message : 'Upload failed';
        setStatus((s) => ({ ...s, [key]: 'error', [errKey]: msg }));
      });
  };

  return (
    <tr className="border-t border-zinc-800 align-top">
      <td className="px-4 py-3 font-mono text-sm">
        {release.version}+{release.build}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-400">{release.platform}</td>
      <td className="px-4 py-3 text-xs">
        {/* v0.8 CONTRACT (SPEC §23 release<->commit): commitSha is optional (older server, or a
            release ingested before an app started sending one) — nothing renders when absent. */}
        {release.commitSha ? (
          <CommitLink sha={release.commitSha} repoUrl={repoUrl} />
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-400">{formatTs(release.mappingUploadedAt)}</td>
      <td className="px-4 py-3 text-xs text-zinc-400">{formatTs(release.sourcemapUploadedAt)}</td>
      <td className="px-4 py-3">
        <ReleaseMapsCount releaseId={release.id} eager={eagerMaps} />
      </td>
      <td className="px-4 py-3">
        <UploadCell
          label="Mapping"
          state={status.mapping}
          progress={status.mappingProgress}
          errorMsg={status.mappingError}
          inputRef={mappingRef}
          onChange={(file) => {
            upload(file, false);
          }}
        />
      </td>
      <td className="px-4 py-3">
        <UploadCell
          label="Source map"
          state={status.sourcemap}
          progress={status.sourcemapProgress}
          errorMsg={status.sourcemapError}
          inputRef={sourcemapRef}
          onChange={(file) => {
            upload(file, true);
          }}
        />
      </td>
    </tr>
  );
};

export const Releases = () => {
  const { projectId } = useParams({ from: '/projects/$projectId/releases' });
  const qc = useQueryClient();

  const projectQ = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  });

  const releasesQ = useQuery({
    queryKey: ['releases', projectId],
    queryFn: () => api.listReleases(projectId),
  });

  const project = projectQ.data?.project;

  const invalidateReleases = (): void => {
    void qc.invalidateQueries({ queryKey: ['releases', projectId] });
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="text-sm text-zinc-500 hover:text-zinc-300"
        >
          ← {project?.name ?? '…'}
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Releases</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Releases are created automatically when events are ingested. Upload symbols here to enable
          symbolication.
        </p>
      </div>

      {releasesQ.isLoading && <div className="text-zinc-500 text-sm">Loading…</div>}
      {releasesQ.isError && <div className="text-red-400 text-sm">Failed to load releases.</div>}

      {releasesQ.data && releasesQ.data.releases.length === 0 && (
        <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-zinc-500 text-sm">
          No releases yet. Ingest an event to auto-create a release.
        </div>
      )}

      {releasesQ.data && releasesQ.data.releases.length > 0 && (
        <div className="rounded border border-zinc-800 overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-zinc-900 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2">Version</th>
                <th className="px-4 py-2">Platform</th>
                <th className="px-4 py-2">Commit</th>
                <th className="px-4 py-2">Mapping uploaded</th>
                <th className="px-4 py-2">Source map uploaded</th>
                <th className="px-4 py-2">Maps</th>
                <th className="px-4 py-2">Upload mapping</th>
                <th className="px-4 py-2">Upload source map</th>
              </tr>
            </thead>
            <tbody>
              {releasesQ.data.releases.map((r) => (
                <ReleaseRow
                  key={r.id}
                  release={r}
                  eagerMaps={releasesQ.data.releases.length <= EAGER_MAP_COUNT_THRESHOLD}
                  onUploadDone={invalidateReleases}
                  repoUrl={project?.repoUrl}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
