// Public entry for @uh-oh/mcp. The stdio bin (stdio.ts) is a separate compiled
// entry and is intentionally not re-exported here (it has import-time side
// effects).

export * from './backend.js';
export {
  registerUhOhTools,
  createUhOhMcpServer,
  TOOL_SCOPE,
  scopeError,
  type ToolScope,
  type RequiredScope,
} from './tools.js';
export { HttpBackend, type HttpBackendConfig } from './http-backend.js';
export { parseMetricsSubset, type MetricsSubset } from './metrics.js';

// Re-export the SDK pieces the server's /mcp route builds on, so packages/server
// depends only on @uh-oh/mcp (workspace) rather than taking a direct dependency
// on @modelcontextprotocol/sdk. Everything flows through one SDK instance, so
// the transport and server types stay identical across the two packages.
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Client-side pieces, re-exported for embedding an in-process client and for
// downstream tests that drive the tool registry (over an in-memory pair or a
// live HTTP endpoint) without a direct @modelcontextprotocol/sdk dependency.
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
