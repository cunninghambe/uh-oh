// v0.5 CONTRACT I: issue detail's "Impact" panel — distinct users (hidden when null) plus
// compact top-5 lists for devices/OS/releases/platforms, each rendered as a small bar-ish plain
// div (no chart library, per the brief). Callers (Issue.tsx) only mount this once the impact
// query has actually succeeded, so there's no loading/error state to handle in here.
import type { ImpactSummary } from '../api.js';
import { barPercent, impactLists, isImpactEmpty } from './ImpactPanel.utils.js';

const ImpactBar = ({ label, events, max }: { label: string; events: number; max: number }) => (
  <div className="flex items-center gap-2 text-xs">
    <span className="w-28 shrink-0 truncate text-zinc-400" title={label}>
      {label}
    </span>
    <div className="h-3 flex-1 overflow-hidden rounded bg-zinc-900">
      <div
        className="h-full rounded bg-amber-600/70"
        style={{ width: `${String(barPercent(events, max))}%` }}
      />
    </div>
    <span className="w-10 shrink-0 text-right tabular-nums text-zinc-500">{events}</span>
  </div>
);

export const ImpactPanel = ({ impact }: { impact: ImpactSummary }) => {
  if (isImpactEmpty(impact)) return null;
  const lists = impactLists(impact);

  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">Impact</h2>
      <div className="rounded border border-zinc-800 p-4 space-y-4">
        {impact.distinctUsers !== null && (
          <div className="text-xs text-zinc-400">
            <span className="text-lg font-semibold text-zinc-200 tabular-nums">
              {impact.distinctUsers}
            </span>{' '}
            distinct user{impact.distinctUsers === 1 ? '' : 's'} affected
          </div>
        )}
        {lists.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {lists.map((list) => (
              <div key={list.title} className="space-y-1.5">
                <div className="text-[11px] uppercase tracking-wide text-zinc-600">
                  {list.title}
                </div>
                <div className="space-y-1">
                  {list.rows.map((row) => (
                    <ImpactBar
                      key={row.label}
                      label={row.label}
                      events={row.events}
                      max={list.max}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
