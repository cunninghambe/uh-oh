const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * POSTs an EventEnvelope to the server's ingest endpoint.
 * Returns `{ ok: true, status: 202 }` on success.
 * Returns `{ ok: false, status }` on non-2xx.
 * Returns `{ ok: false }` on network error or timeout.
 */
export async function sendEvent(ingestUrl, publicKey, env, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = opts.fetchFn ?? fetch;
    const url = `${ingestUrl}/ingest/${publicKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(env),
            signal: controller.signal,
        });
        return { ok: res.ok, status: res.status };
    }
    catch {
        return { ok: false };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=transport.js.map