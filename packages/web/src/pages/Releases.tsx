import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { ApiError, type Release, api } from '../api.js';

type UploadState = 'idle' | 'uploading' | 'done' | 'error';

type RowUploadStatus = {
  mapping: UploadState;
  sourcemap: UploadState;
  mappingError: string | null;
  sourcemapError: string | null;
};

const formatTs = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleString());

const UploadCell = ({
  label,
  state,
  errorMsg,
  inputRef,
  onChange,
}: {
  label: string;
  state: UploadState;
  errorMsg: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (file: File) => void;
}) => (
  <div className="space-y-1">
    <label className="block text-xs text-zinc-500">{label}</label>
    <input
      ref={inputRef}
      type="file"
      accept={label === 'Mapping' ? '.txt,text/plain' : '.map,application/json'}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) onChange(file);
      }}
      disabled={state === 'uploading'}
      className="block text-xs text-zinc-400 file:mr-2 file:rounded file:border-0 file:bg-zinc-700 file:px-2 file:py-1 file:text-xs file:text-zinc-200 hover:file:bg-zinc-600 disabled:opacity-50"
    />
    {state === 'uploading' && <span className="text-xs text-zinc-500">Uploading…</span>}
    {state === 'done' && <span className="text-xs text-emerald-400">Uploaded</span>}
    {state === 'error' && (
      <span className="text-xs text-red-400">{errorMsg ?? 'Upload failed'}</span>
    )}
  </div>
);

const ReleaseRow = ({ release, onUploadDone }: { release: Release; onUploadDone: () => void }) => {
  const [status, setStatus] = useState<RowUploadStatus>({
    mapping: 'idle',
    sourcemap: 'idle',
    mappingError: null,
    sourcemapError: null,
  });
  const mappingRef = useRef<HTMLInputElement | null>(null);
  const sourcemapRef = useRef<HTMLInputElement | null>(null);

  const upload = (file: File, isSourcemap: boolean): void => {
    const key = isSourcemap ? 'sourcemap' : 'mapping';
    const errKey = isSourcemap ? 'sourcemapError' : 'mappingError';
    setStatus((s) => ({ ...s, [key]: 'uploading', [errKey]: null }));
    api
      .uploadSymbols(release.id, file, { sourcemap: isSourcemap })
      .then(() => {
        setStatus((s) => ({ ...s, [key]: 'done' }));
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
      <td className="px-4 py-3 text-xs text-zinc-400">{formatTs(release.mappingUploadedAt)}</td>
      <td className="px-4 py-3 text-xs text-zinc-400">{formatTs(release.sourcemapUploadedAt)}</td>
      <td className="px-4 py-3">
        <UploadCell
          label="Mapping"
          state={status.mapping}
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
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-zinc-900 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2">Version</th>
                <th className="px-4 py-2">Platform</th>
                <th className="px-4 py-2">Mapping uploaded</th>
                <th className="px-4 py-2">Source map uploaded</th>
                <th className="px-4 py-2">Upload mapping</th>
                <th className="px-4 py-2">Upload source map</th>
              </tr>
            </thead>
            <tbody>
              {releasesQ.data.releases.map((r) => (
                <ReleaseRow key={r.id} release={r} onUploadDone={invalidateReleases} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
