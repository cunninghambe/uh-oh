import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';

import { api } from '../api.js';

export const ProjectSettings = () => {
  const { projectId } = useParams({ from: '/projects/$projectId/settings' });
  const qc = useQueryClient();

  const projectQ = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  });

  const project = projectQ.data?.project;

  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [alertDedupeMinutes, setAlertDedupeMinutes] = useState(30);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setWebhookUrl(project.webhookUrl ?? '');
      setAlertDedupeMinutes(project.alertDedupeMinutes);
    }
  }, [project]);

  const updateM = useMutation({
    mutationFn: () =>
      api.updateProject(projectId, {
        name: name.trim(),
        webhookUrl: webhookUrl.trim() || null,
        alertDedupeMinutes,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      setName(data.project.name);
      setWebhookUrl(data.project.webhookUrl ?? '');
      setAlertDedupeMinutes(data.project.alertDedupeMinutes);
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
      }, 3000);
    },
  });

  const rotateM = useMutation({
    mutationFn: () => api.rotateKey(projectId),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      setRotatedKey(data.project.publicKey);
      setConfirmRotate(false);
    },
  });

  const handleSave = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (updateM.isPending) return;
    updateM.mutate();
  };

  if (projectQ.isLoading) return <div className="text-zinc-500 text-sm">Loading…</div>;
  if (projectQ.isError || !project)
    return <div className="text-red-400 text-sm">Failed to load project.</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="text-sm text-zinc-500 hover:text-zinc-300"
        >
          ← {project.name}
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Settings</h1>
      </div>

      <section className="rounded border border-zinc-800 bg-zinc-900 p-6 space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">Project</h2>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="proj-name" className="block text-xs text-zinc-400">
              Name
            </label>
            <input
              id="proj-name"
              type="text"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setName(e.target.value);
              }}
              maxLength={128}
              required
              className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="webhook-url" className="block text-xs text-zinc-400">
              Webhook URL <span className="text-zinc-600">(optional)</span>
            </label>
            <input
              id="webhook-url"
              type="url"
              value={webhookUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setWebhookUrl(e.target.value);
              }}
              maxLength={1024}
              placeholder="https://…"
              className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="dedupe-minutes" className="block text-xs text-zinc-400">
              Alert dedupe minutes
            </label>
            <input
              id="dedupe-minutes"
              type="number"
              min={0}
              step={1}
              value={alertDedupeMinutes}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setAlertDedupeMinutes(Math.max(0, parseInt(e.target.value, 10) || 0));
              }}
              className="w-32 rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={updateM.isPending || !name.trim()}
              className="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {updateM.isPending ? 'Saving…' : 'Save'}
            </button>
            {saveSuccess && <span className="text-xs text-emerald-400">Saved.</span>}
            {updateM.isError && (
              <span className="text-xs text-red-400">{updateM.error.message}</span>
            )}
          </div>
        </form>
      </section>

      <section className="rounded border border-zinc-800 bg-zinc-900 p-6 space-y-4">
        <h2 className="text-sm font-medium text-zinc-300">Public key</h2>
        <div className="font-mono text-xs text-zinc-400 break-all">{project.publicKey}</div>
        {rotatedKey && (
          <div className="rounded border border-emerald-700 bg-emerald-950 p-3 space-y-2">
            <div className="text-xs text-emerald-300 font-medium">
              New public key — update your app DSN
            </div>
            <div className="font-mono text-xs text-emerald-200 break-all">{rotatedKey}</div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(rotatedKey);
              }}
              className="text-xs text-emerald-400 hover:text-emerald-200 underline"
            >
              Copy
            </button>
          </div>
        )}
        {confirmRotate ? (
          <div className="space-y-2">
            <p className="text-xs text-red-400">
              Rotating the key will invalidate the current DSN. All apps must be updated before they
              can send events again.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  rotateM.mutate();
                }}
                disabled={rotateM.isPending}
                className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {rotateM.isPending ? 'Rotating…' : 'Confirm rotate'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmRotate(false);
                }}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
            </div>
            {rotateM.isError && <div className="text-xs text-red-400">{rotateM.error.message}</div>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirmRotate(true);
            }}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
          >
            Rotate key…
          </button>
        )}
      </section>
    </div>
  );
};
