// v0.6 CONTRACT U-API: the Project page's "Usage" section — headline stats, a 30-day dual-series
// trend chart, and three top-lists (pages/referrers/events), with a 7/30/90-day selector.
// GET /api/projects/:id/usage/summary?days= via a `retry:false` query; on error the whole
// section (including its heading) stays hidden, same pattern as MonitorsSection.tsx — a server
// agent implements this contract concurrently and the endpoint may 404 until it lands.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api.js';
import { barPercent } from './ImpactPanel.utils.js';
import {
  DEFAULT_USAGE_DAYS,
  USAGE_DAY_OPTIONS,
  USAGE_EMPTY_HINT,
  usageBarLists,
  type UsageDaysOption,
} from './UsageSection.utils.js';
import { UsageTrendChart } from './UsageTrendChart.js';

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div className="text-xs text-zinc-400">
    <span className="text-lg font-semibold text-zinc-200 tabular-nums">{value}</span> {label}
  </div>
);

const UsageBarRow = ({
  label,
  primary,
  secondary,
  max,
}: {
  label: string;
  primary: number;
  secondary?: number | undefined;
  max: number;
}) => (
  <div className="flex items-center gap-2 text-xs">
    <span className="w-28 shrink-0 truncate text-zinc-400" title={label}>
      {label}
    </span>
    <div className="h-3 flex-1 overflow-hidden rounded bg-zinc-900">
      <div
        className="h-full rounded bg-amber-600/70"
        style={{ width: `${String(barPercent(primary, max))}%` }}
      />
    </div>
    <span className="w-10 shrink-0 text-right tabular-nums text-zinc-500">{primary}</span>
    {secondary !== undefined && (
      <span className="w-10 shrink-0 text-right tabular-nums text-zinc-600">{secondary}</span>
    )}
  </div>
);

export const UsageSection = ({ projectId }: { projectId: string }) => {
  const [days, setDays] = useState<UsageDaysOption>(DEFAULT_USAGE_DAYS);

  // v0.6 CONTRACT U-API: server agent work landing concurrently, may 404 until it does.
  // retry: false so an absent endpoint fails fast — isError then just means "hide the section"
  // (see render below), same as MonitorsSection.tsx's statsQ/monitorsQ.
  const usageQ = useQuery({
    queryKey: ['usage-summary', projectId, days],
    queryFn: () => api.getUsageSummary(projectId, days),
    retry: false,
  });

  if (usageQ.isError) return null;

  const summary = usageQ.data;
  const lists = summary ? usageBarLists(summary) : [];

  return (
    <section>
      <div className="flex items-center justify-between gap-4 mb-2">
        <h2 className="text-sm uppercase tracking-wide text-zinc-500">Usage</h2>
        <div className="flex gap-1" role="group" aria-label="Usage window">
          {USAGE_DAY_OPTIONS.map((d) => (
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

      {usageQ.isLoading && <div className="text-sm text-zinc-500">Loading usage…</div>}

      {summary && (
        <div className="rounded border border-zinc-800 p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-6">
            <Stat label="visitors" value={summary.totals.visitors} />
            <Stat label="pageviews" value={summary.totals.pageviews} />
            <Stat label="custom events" value={summary.totals.events} />
          </div>

          <UsageTrendChart days={summary.days} totals={summary.totals} />

          {lists.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {lists.map((list) => (
                <div key={list.title} className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-600">
                    {list.title}
                  </div>
                  <div className="space-y-1">
                    {list.rows.map((row) => (
                      <UsageBarRow
                        key={row.label}
                        label={row.label}
                        primary={row.primary}
                        secondary={row.secondary}
                        max={list.max}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // v0.6 CONTRACT U-API brief: trend-chart "zero-data" hint and top-lists "ALL lists
            // empty" fallback are "the empty-state hint" (singular, reused) — a summary with
            // zero totals can never produce a populated top-list (pageviews>0 always yields a
            // topPages row, etc.), so this one slot right after the chart satisfies both bullets
            // at once instead of showing the same sentence twice.
            <p className="text-xs text-zinc-600">{USAGE_EMPTY_HINT}</p>
          )}
        </div>
      )}
    </section>
  );
};
