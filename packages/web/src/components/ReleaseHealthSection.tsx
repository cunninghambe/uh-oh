// v0.9 CONTRACT (SPEC §24 release health): the Project page's "Release health" section — a table
// of releases with events in the selected window plus a totals row, and a 7/30/90-day selector.
// GET /api/projects/:id/release-health?days= via a `retry:false` query; on error the whole
// section (including its heading) stays hidden, same pattern as UsageSection.tsx/
// MonitorsSection.tsx — a server agent implements this contract concurrently and the endpoint
// may 404 until it lands.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api, type ReleaseHealthTotals } from '../api.js';
import { CommitLink } from './CommitLink.js';
import { PlatformBadge } from './PlatformBadge.js';
import {
  DEFAULT_RELEASE_HEALTH_DAYS,
  RELEASE_HEALTH_DAY_OPTIONS,
  crashRatioBadgeStyle,
  releaseLabel,
  type ReleaseHealthDaysOption,
} from './ReleaseHealthSection.utils.js';

const RatioBadge = ({ ratio }: { ratio: number | null }) => {
  const style = crashRatioBadgeStyle(ratio);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] tabular-nums ${style.className}`}
    >
      {style.label}
    </span>
  );
};

const TotalsRow = ({ totals }: { totals: ReleaseHealthTotals }) => (
  <tr className="border-t border-zinc-700 bg-zinc-900/60 font-medium text-zinc-300">
    <td className="px-4 py-3" colSpan={3}>
      Total
    </td>
    <td className="px-4 py-3 text-right tabular-nums">{totals.events}</td>
    <td className="px-4 py-3 text-right tabular-nums">{totals.fatalEvents}</td>
    <td className="px-4 py-3 text-right tabular-nums">{totals.distinctIssues}</td>
    <td className="px-4 py-3 text-right tabular-nums">{totals.pageviews}</td>
    <td className="px-4 py-3 text-right">
      <RatioBadge ratio={totals.crashesPer1kPageviews} />
    </td>
  </tr>
);

export const ReleaseHealthSection = ({
  projectId,
  repoUrl,
}: {
  projectId: string;
  repoUrl: string | null | undefined;
}) => {
  const [days, setDays] = useState<ReleaseHealthDaysOption>(DEFAULT_RELEASE_HEALTH_DAYS);

  // v0.9 CONTRACT — server agent work landing concurrently, may 404 until it does. retry: false
  // so an absent endpoint fails fast — isError then just means "hide the section" (see render
  // below), same as UsageSection.tsx's usageQ/MonitorsSection.tsx's monitorsQ.
  const healthQ = useQuery({
    queryKey: ['release-health', projectId, days],
    queryFn: () => api.getReleaseHealth(projectId, days),
    retry: false,
  });

  if (healthQ.isError) return null;

  const health = healthQ.data;

  return (
    <section>
      <div className="flex items-center justify-between gap-4 mb-2">
        <h2 className="text-sm uppercase tracking-wide text-zinc-500">Release health</h2>
        <div className="flex gap-1" role="group" aria-label="Release health window">
          {RELEASE_HEALTH_DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => {
                setDays(d);
              }}
              className={`rounded border px-2 py-1 text-xs ${
                days === d
                  ? 'border-amber-500 text-amber-400'
                  : 'border-zinc-700 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {healthQ.isLoading && <div className="text-sm text-zinc-500">Loading release health…</div>}

      {health && health.releases.length === 0 && (
        <div className="rounded border border-dashed border-zinc-800 p-6 text-center text-zinc-500 text-sm">
          No releases with events in this window.
        </div>
      )}

      {health && health.releases.length > 0 && (
        <div className="rounded border border-zinc-800 overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-zinc-900 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2">Release</th>
                <th className="px-4 py-2">Platform</th>
                <th className="px-4 py-2">Commit</th>
                <th className="px-4 py-2 text-right">Events</th>
                <th className="px-4 py-2 text-right">Fatal</th>
                <th className="px-4 py-2 text-right">Issues</th>
                <th className="px-4 py-2 text-right">Pageviews</th>
                <th className="px-4 py-2 text-right">Crashes/1k</th>
              </tr>
            </thead>
            <tbody>
              {health.releases.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800">
                  <td className="px-4 py-3 font-mono text-sm">
                    {releaseLabel(r.version, r.build)}
                  </td>
                  <td className="px-4 py-3">
                    <PlatformBadge platform={r.platform} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.commitSha ? (
                      <CommitLink sha={r.commitSha} repoUrl={repoUrl} />
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.events}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.fatalEvents}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.distinctIssues}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.pageviews}</td>
                  <td className="px-4 py-3 text-right">
                    <RatioBadge ratio={r.crashesPer1kPageviews} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <TotalsRow totals={health.totals} />
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
};
