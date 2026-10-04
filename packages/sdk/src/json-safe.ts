import type { EventEnvelope, JsonValue } from '@uh-oh/types';

const MAX_DEPTH = 32;

/**
 * Converts any value into plain JSON data, never throwing. Mirrors
 * JSON.stringify (toJSON honoured, undefined/functions/symbols dropped from
 * objects and nulled in arrays, non-finite numbers become null) and also
 * survives what JSON.stringify throws on: a BigInt becomes its decimal string,
 * a true cycle becomes "[Circular]", a throwing toJSON or getter becomes
 * "[unserializable]", and nesting past 32 levels becomes "[Truncated]". A value
 * shared by two keys is not a cycle and is kept on both.
 *
 * Kept in step with toJsonSafe in packages/js/src/uh-oh-client.ts (that file
 * is vendored single-file with zero imports, so it cannot share this module).
 */
export function toJsonSafe(value: unknown, ancestors: object[] = []): JsonValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined; // undefined, function, symbol
  }
  const obj = value;
  if (ancestors.includes(obj)) return '[Circular]';
  if (ancestors.length >= MAX_DEPTH) return '[Truncated]';
  try {
    const toJSON = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return toJsonSafe((toJSON as () => unknown).call(obj), ancestors);
    }
    ancestors.push(obj);
    try {
      if (Array.isArray(obj)) {
        return obj.map((item: unknown) => {
          try {
            return toJsonSafe(item, ancestors) ?? null;
          } catch {
            return '[unserializable]';
          }
        });
      }
      const out: Record<string, JsonValue> = {};
      for (const key of Object.keys(obj)) {
        let v: JsonValue | undefined;
        try {
          v = toJsonSafe((obj as Record<string, unknown>)[key], ancestors);
        } catch {
          v = '[unserializable]';
        }
        if (v !== undefined) out[key] = v;
      }
      return out;
    } finally {
      ancestors.pop();
    }
  } catch {
    return '[unserializable]';
  }
}

/**
 * Returns the envelope as plain JSON data so the spool can always serialize
 * it. An ordinary envelope takes the fast path (a plain JSON round trip); only
 * when JSON.stringify throws does the tolerant walk run.
 */
export function jsonSafeEnvelope(env: EventEnvelope): EventEnvelope {
  try {
    return JSON.parse(JSON.stringify(env)) as EventEnvelope;
  } catch {
    return toJsonSafe(env) as unknown as EventEnvelope;
  }
}
