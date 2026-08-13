/**
 * MCP over HTTP
 *
 * Mounts GitNexus on Express using the MCP Streamable HTTP transport. Every
 * client gets an isolated MCP session while the LocalBackend remains shared.
 * Remote exposure is fail-closed: callers must configure a bearer token or
 * explicitly opt into unauthenticated access, and mutating tools are a
 * separate opt-in.
 */

import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { createMCPServer } from '../mcp/server.js';
import type { LocalBackend } from '../mcp/local/local-backend.js';

interface MCPSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

interface RateBucket {
  count: number;
  windowStartedAt: number;
}

export interface MCPHTTPOptions {
  /** Whether the HTTP listener is reachable beyond loopback. */
  remoteAccess?: boolean;
  /** Bearer token required by /api/mcp. Never accepted via a query string. */
  bearerToken?: string;
  /** Explicitly allow unauthenticated remote MCP access. */
  allowInsecure?: boolean;
  /** Expose non-read-only MCP tools. Defaults to true only on loopback. */
  allowMutatingTools?: boolean;
  /** Maximum live plus initializing sessions. */
  maxSessions?: number;
  /** Per-client fixed-window request budget. */
  maxRequestsPerMinute?: number;
  /** Maximum serialized JSON-RPC request size accepted by this route. */
  maxRequestBytes?: number;
  /** Idle session lifetime. Primarily configurable for deterministic tests. */
  sessionTtlMs?: number;
  /** Cleanup interval. Primarily configurable for deterministic tests. */
  cleanupIntervalMs?: number;
}

export interface ResolvedMCPHTTPOptions {
  remoteAccess: boolean;
  bearerToken?: string;
  allowInsecure: boolean;
  allowMutatingTools: boolean;
  maxSessions: number;
  maxRequestsPerMinute: number;
  maxRequestBytes: number;
  sessionTtlMs: number;
  cleanupIntervalMs: number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_REQUESTS_PER_MINUTE = 240;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

function envFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function boundedInteger(
  value: number | string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** Conservatively classify bind addresses; unknown hostnames are remote. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;

  if (isIP(normalized) === 4) {
    return normalized.split('.')[0] === '127';
  }

  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) === 4 && mapped.split('.')[0] === '127';
  }

  return false;
}

/** Resolve secure defaults once, before mounting the HTTP endpoint. */
export function resolveMCPHTTPOptions(
  host: string,
  overrides: MCPHTTPOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMCPHTTPOptions {
  const remoteAccess = overrides.remoteAccess ?? !isLoopbackHost(host);
  const bearerToken = overrides.bearerToken ?? env.GITNEXUS_MCP_TOKEN ?? undefined;

  return {
    remoteAccess,
    ...(bearerToken ? { bearerToken } : {}),
    allowInsecure: overrides.allowInsecure ?? envFlag(env.GITNEXUS_MCP_INSECURE),
    allowMutatingTools:
      overrides.allowMutatingTools ?? (!remoteAccess || envFlag(env.GITNEXUS_MCP_ALLOW_MUTATIONS)),
    maxSessions: boundedInteger(
      overrides.maxSessions ?? env.GITNEXUS_MCP_MAX_SESSIONS,
      DEFAULT_MAX_SESSIONS,
      1,
      1024,
    ),
    maxRequestsPerMinute: boundedInteger(
      overrides.maxRequestsPerMinute ?? env.GITNEXUS_MCP_REQUESTS_PER_MINUTE,
      DEFAULT_REQUESTS_PER_MINUTE,
      1,
      100_000,
    ),
    maxRequestBytes: boundedInteger(
      overrides.maxRequestBytes ?? env.GITNEXUS_MCP_MAX_REQUEST_BYTES,
      DEFAULT_MAX_REQUEST_BYTES,
      1024,
      10 * 1024 * 1024,
    ),
    sessionTtlMs: boundedInteger(
      overrides.sessionTtlMs,
      DEFAULT_SESSION_TTL_MS,
      1000,
      24 * 60 * 60 * 1000,
    ),
    cleanupIntervalMs: boundedInteger(
      overrides.cleanupIntervalMs,
      DEFAULT_CLEANUP_INTERVAL_MS,
      1000,
      60 * 60 * 1000,
    ),
  };
}

function sendMCPError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function tokenMatches(actual: string, expected: string): boolean {
  return timingSafeEqual(digestToken(actual), digestToken(expected));
}

function bearerTokenFrom(req: Request): string | undefined {
  const authorization = req.header('authorization');
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

function serializedBodyBytes(body: unknown): number {
  if (body === undefined || body === null) return 0;
  try {
    const serialized = JSON.stringify(body);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === 'initialize'
  );
}

export function mountMCPEndpoints(
  app: Express,
  backend: LocalBackend,
  rawOptions: MCPHTTPOptions = {},
): () => Promise<void> {
  // Direct callers are treated as loopback unless they explicitly say the
  // listener is remote. createServer() always supplies the bind-derived value.
  const options = resolveMCPHTTPOptions(
    rawOptions.remoteAccess ? '0.0.0.0' : '127.0.0.1',
    rawOptions,
  );
  const sessions = new Map<string, MCPSession>();
  const rateBuckets = new Map<string, RateBucket>();
  let pendingInitializations = 0;

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > options.sessionTtlMs) {
        sessions.delete(id);
        void Promise.resolve(session.server.close()).catch(() => {});
      }
    }

    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.windowStartedAt >= 60_000) rateBuckets.delete(key);
    }
  }, options.cleanupIntervalMs);
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }

  const handleMcpRequest = async (req: Request, res: Response) => {
    if (options.remoteAccess && !options.bearerToken && !options.allowInsecure) {
      sendMCPError(
        res,
        503,
        -32003,
        'Remote MCP is disabled. Configure GITNEXUS_MCP_TOKEN or explicitly opt into insecure access.',
      );
      return;
    }

    if (options.bearerToken) {
      const suppliedToken = bearerTokenFrom(req);
      if (!suppliedToken || !tokenMatches(suppliedToken, options.bearerToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="gitnexus-mcp"');
        sendMCPError(res, 401, -32003, 'Unauthorized');
        return;
      }
    }

    const contentLength = Number(req.header('content-length'));
    if (
      (Number.isFinite(contentLength) && contentLength > options.maxRequestBytes) ||
      serializedBodyBytes(req.body) > options.maxRequestBytes
    ) {
      sendMCPError(res, 413, -32005, 'MCP request body is too large.');
      return;
    }

    const rateKey = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = rateBuckets.get(rateKey);
    if (!bucket || now - bucket.windowStartedAt >= 60_000) {
      bucket = { count: 0, windowStartedAt: now };
      rateBuckets.set(rateKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.maxRequestsPerMinute) {
      res.setHeader('Retry-After', '60');
      sendMCPError(res, 429, -32004, 'MCP request rate limit exceeded.');
      return;
    }

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    const existingSession = sessionId ? sessions.get(sessionId) : undefined;
    if (existingSession) {
      const session = existingSession;
      session.lastActivity = now;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      sendMCPError(res, 404, -32001, 'Session not found. Re-initialize.');
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      sendMCPError(res, 400, -32000, 'No valid session. Send a POST initialize request.');
      return;
    }

    if (sessions.size + pendingInitializations >= options.maxSessions) {
      res.setHeader('Retry-After', '5');
      sendMCPError(res, 429, -32004, 'MCP session limit reached.');
      return;
    }

    pendingInitializations += 1;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    const server = createMCPServer(backend, {
      allowMutatingTools: options.allowMutatingTools,
    });
    let retained = false;

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      const initializedSessionId = transport.sessionId;
      if (initializedSessionId) {
        retained = true;
        sessions.set(initializedSessionId, { server, transport, lastActivity: Date.now() });
        transport.onclose = () => {
          sessions.delete(initializedSessionId);
        };
      }
    } finally {
      pendingInitializations -= 1;
      if (!retained) {
        await Promise.resolve(server.close()).catch(() => {});
      }
    }
  };

  app.all('/api/mcp', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Authorization');
    void handleMcpRequest(req, res).catch((err: unknown) => {
      console.error('MCP HTTP request failed:', err);
      if (res.headersSent) return;
      sendMCPError(res, 500, -32000, 'Internal MCP server error');
    });
  });

  const cleanup = async () => {
    clearInterval(cleanupTimer);
    const closers = [...sessions.values()].map(async (session) => {
      try {
        await Promise.resolve(session.server.close());
      } catch {}
    });
    sessions.clear();
    rateBuckets.clear();
    await Promise.allSettled(closers);
  };

  if (options.remoteAccess && !options.bearerToken && !options.allowInsecure) {
    console.warn(
      'MCP HTTP endpoint mounted at /api/mcp but remote access is disabled until GITNEXUS_MCP_TOKEN is configured.',
    );
  } else {
    const mode = options.allowMutatingTools ? 'read/write' : 'read-only';
    const auth = options.bearerToken ? 'Bearer auth' : 'no auth';
    console.log(`MCP HTTP endpoint mounted at /api/mcp (${mode}, ${auth})`);
  }

  return cleanup;
}
