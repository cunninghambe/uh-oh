import type { EventEnvelope } from './_uh_oh_types';
export type SendResult = {
    ok: boolean;
    status?: number;
};
/**
 * POSTs an EventEnvelope to the server's ingest endpoint.
 * Returns `{ ok: true, status: 202 }` on success.
 * Returns `{ ok: false, status }` on non-2xx.
 * Returns `{ ok: false }` on network error or timeout.
 */
export declare function sendEvent(ingestUrl: string, publicKey: string, env: EventEnvelope, opts?: {
    timeoutMs?: number;
    fetchFn?: typeof fetch;
}): Promise<SendResult>;
//# sourceMappingURL=transport.d.ts.map