import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { api } from '../api.js';

const formatTimestamp = (ms: number): string => new Date(ms).toLocaleString();

export const Home = () => {
  const qc = useQueryClient();
  const projectsQ = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });
  const [name, setName] = useState('');
  const createM = useMutation({
    mutationFn: (n: string) => api.createProject(n),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <section>
        <h1 className="text-2xl font-semibold mb-1">Projects</h1>
        <p className="text-zinc-400 text-sm">
          Each project gets a public key used in its DSN. Send crashes to{' '}
          <code className="text-zinc-300">POST /ingest/&lt;publicKey&gt;</code>.
        </p>
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) createM.mutate(name.trim());
        }}
        className="flex gap-2"
      >
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="New project name"
          className="flex-1 rounded bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
          maxLength={128}
        />
        <button
          type="submit"
          disabled={!name.trim() || createM.isPending}
          className="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
        >
          Create
        </button>
      </form>

      {createM.isError && (
        <div className="text-sm text-red-400">Error: {createM.error.message}</div>
      )}

      {projectsQ.isLoading && <div className="text-zinc-500 text-sm">Loading…</div>}
      {projectsQ.isError && <div className="text-red-400 text-sm">Failed to load projects.</div>}

      {projectsQ.data && projectsQ.data.projects.length === 0 && (
        <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-zinc-500">
          No projects yet. Create one above.
        </div>
      )}

      {projectsQ.data && projectsQ.data.projects.length > 0 && (
        <div className="space-y-2">
          {projectsQ.data.projects.map((p) => (
            <Link
              key={p.id}
              to="/projects/$projectId"
              params={{ projectId: p.id }}
              className="block rounded border border-zinc-800 bg-zinc-900 px-4 py-3 hover:border-zinc-700"
            >
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-zinc-500">{p.slug}</div>
                </div>
                <div className="text-xs text-zinc-500">created {formatTimestamp(p.createdAt)}</div>
              </div>
              <div className="mt-2 text-xs font-mono text-zinc-500 break-all">
                publicKey: {p.publicKey}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};
