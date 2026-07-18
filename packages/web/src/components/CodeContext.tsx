// v0.5 CONTRACT S: renders a symbolicated frame's source context (if the server attached one) as
// a collapsible, monospace code block — line numbers derived from the frame's resolved `lineno`,
// the crash line highlighted, pre/post dimmed. Uses a native <details>/<summary> (no local state
// needed) so it stays a plain function component with no hooks. Frames without `context` never
// mount this at all (see Issue.tsx) — "frames without context render exactly as today".
import type { FrameContext } from '../api.js';
import { codeContextRows } from './CodeContext.utils.js';

export const CodeContext = ({
  context,
  lineno,
}: {
  context: FrameContext;
  lineno: number | undefined;
}) => {
  const rows = codeContextRows(context, lineno);
  if (rows.length === 0) return null;

  return (
    <details className="px-3 pb-1.5">
      <summary className="cursor-pointer select-none text-[11px] text-zinc-600 hover:text-zinc-400">
        Source
      </summary>
      {/* overflow-x-auto on this wrapper (not the table) is what keeps a long line's highlight
          scrollable-but-intact instead of wrapping off-screen — see the brief's "Long lines"
          rule. `whitespace-pre` on each cell is what stops the wrap in the first place. */}
      <div className="mt-1 overflow-x-auto rounded border border-zinc-800 bg-black">
        <table className="w-full border-collapse text-[11px] font-mono leading-5">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={row.isCrashLine ? 'bg-amber-950/50' : ''}>
                <td
                  className={`select-none whitespace-nowrap px-2 text-right ${
                    row.isCrashLine ? 'text-amber-500' : 'text-zinc-700'
                  }`}
                >
                  {row.lineNumber ?? ''}
                </td>
                <td
                  className={`whitespace-pre px-2 ${
                    row.isCrashLine ? 'text-amber-200' : 'text-zinc-600'
                  }`}
                >
                  {row.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
};
