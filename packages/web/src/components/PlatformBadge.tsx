// v0.3 item 3: small badge showing which platform (web/node/android/ios) an event came from.
// v0.4 CONTRACT P: issue list rows and the issue detail page now also have a (nullable)
// platform of their own — see Project.tsx (list rows) and Issue.tsx (prefers the issue's own
// platform, falling back to the latest event's). `platform` is optional/nullable here so every
// caller can pass either source through directly; absent/null renders nothing.
import type { EventRow } from '../api.js';

export const PlatformBadge = ({
  platform,
}: {
  platform: EventRow['platform'] | null | undefined;
}) => {
  if (!platform) return null;
  return (
    <span className="inline-flex items-center rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
      {platform}
    </span>
  );
};
