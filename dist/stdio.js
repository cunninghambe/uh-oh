#!/usr/bin/env node
// The `uh-oh-mcp` bin: an MCP stdio server that proxies the uh-oh tools to a
// remote server's HTTP API. Run by an MCP host (Claude Code) which speaks
// JSON-RPC over this process's stdin/stdout.
//
// stdout discipline: the StdioServerTransport owns stdout. NOTHING else in this
// process may write there — every diagnostic goes to stderr — or the MCP framing
// is corrupted and the host disconnects.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpBackend } from './http-backend.js';
import { createUhOhMcpServer } from './tools.js';
const logErr = (message) => {
    process.stderr.write(`[uh-oh-mcp] ${message}\n`);
};
const main = async () => {
    const serverUrl = process.env['UH_OH_SERVER_URL'];
    const adminPassword = process.env['UH_OH_ADMIN_PASSWORD'];
    if (!serverUrl || !adminPassword) {
        const missing = [
            ...(!serverUrl ? ['UH_OH_SERVER_URL'] : []),
            ...(!adminPassword ? ['UH_OH_ADMIN_PASSWORD'] : []),
        ];
        logErr(`missing required env var(s): ${missing.join(', ')}`);
        logErr('set UH_OH_SERVER_URL (e.g. https://errors.example.com or http://127.0.0.1:3300) and UH_OH_ADMIN_PASSWORD, then retry.');
        process.exit(1);
    }
    const backend = new HttpBackend({ serverUrl, adminPassword, log: logErr });
    const server = createUhOhMcpServer(backend);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logErr(`ready (stdio) → ${serverUrl}`);
};
main().catch((err) => {
    logErr(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
//# sourceMappingURL=stdio.js.map