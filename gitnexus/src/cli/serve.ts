import { createServer } from '../server/api.js';
import type { MCPHTTPOptions } from '../server/mcp-http.js';

// Catch anything that would cause a silent exit
process.on('uncaughtException', (err) => {
  console.error('\n[gitnexus serve] Uncaught exception:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('\n[gitnexus serve] Unhandled rejection:', reason?.message || reason);
  if (process.env.DEBUG) console.error(reason?.stack);
  process.exit(1);
});

export interface ServeCommandOptions {
  port?: string;
  host?: string;
  /** Programmatic equivalent of GITNEXUS_MCP_TOKEN. */
  mcpToken?: string;
  /** Programmatic equivalent of GITNEXUS_MCP_INSECURE=1. */
  mcpInsecure?: boolean;
  /** Programmatic equivalent of GITNEXUS_MCP_ALLOW_MUTATIONS=1. */
  mcpAllowMutations?: boolean;
  mcpMaxSessions?: number;
  mcpRequestsPerMinute?: number;
}

export const serveCommand = async (options?: ServeCommandOptions) => {
  const port = Number(options?.port ?? 4747);
  // Default to 'localhost' so the OS decides whether to bind to 127.0.0.1 or
  // ::1 based on system configuration, avoiding spurious CORS errors when the
  // hosted frontend at gitnexus.vercel.app connects to localhost.
  const host = options?.host ?? 'localhost';

  const mcp: MCPHTTPOptions = {
    ...(options?.mcpToken !== undefined ? { bearerToken: options.mcpToken } : {}),
    ...(options?.mcpInsecure !== undefined ? { allowInsecure: options.mcpInsecure } : {}),
    ...(options?.mcpAllowMutations !== undefined
      ? { allowMutatingTools: options.mcpAllowMutations }
      : {}),
    ...(options?.mcpMaxSessions !== undefined ? { maxSessions: options.mcpMaxSessions } : {}),
    ...(options?.mcpRequestsPerMinute !== undefined
      ? { maxRequestsPerMinute: options.mcpRequestsPerMinute }
      : {}),
  };

  try {
    await createServer(port, host, { mcp });
  } catch (err: any) {
    console.error(`\nFailed to start GitNexus server:\n`);
    console.error(`  ${err.message || err}\n`);
    if (err.code === 'EADDRINUSE') {
      console.error(`  Port ${port} is already in use. Either:`);
      console.error(`    1. Stop the other process using port ${port}`);
      console.error(`    2. Use a different port: gitnexus serve --port 4748\n`);
    }
    if (err.stack && process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
};
