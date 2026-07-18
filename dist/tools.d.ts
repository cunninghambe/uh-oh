import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type UhOhBackend } from './backend.js';
/**
 * Register every uh-oh tool on `server`, backed by `backend`. This is the only
 * place tools are defined; both transports call it.
 */
export declare const registerUhOhTools: (server: McpServer, backend: UhOhBackend) => void;
/** Convenience: a fully-wired McpServer with every uh-oh tool registered. */
export declare const createUhOhMcpServer: (backend: UhOhBackend) => McpServer;
//# sourceMappingURL=tools.d.ts.map