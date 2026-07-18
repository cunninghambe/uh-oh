// The narrow backend contract that both the in-process (server) and HTTP
// (stdio) implementations satisfy. The tool registry in tools.ts is written
// ONCE against this interface, so the same tools run whether they talk to the
// database directly or to a remote uh-oh server over its /api/*.
//
// All shapes here are plain data (DTOs) that mirror the server's DB rows and
// /api/* JSON responses. This package must never import from @uh-oh/server
// (the server depends on this package, not the other way around).
/**
 * Thrown by a backend when the underlying operation fails in a way that should
 * surface to the MCP client as a tool error (a 4xx from the API, an SSRF-
 * rejected webhook URL, a network/timeout failure). The tool layer catches
 * these and returns an `isError` result rather than throwing.
 */
export class BackendError extends Error {
    code;
    status;
    constructor(message, opts = {}) {
        super(message);
        this.name = 'BackendError';
        this.code = opts.code ?? 'backend_error';
        this.status = opts.status;
    }
}
//# sourceMappingURL=backend.js.map