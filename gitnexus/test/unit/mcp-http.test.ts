import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server as HTTPServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  isLoopbackHost,
  mountMCPEndpoints,
  resolveMCPHTTPOptions,
  type MCPHTTPOptions,
} from '../../src/server/mcp-http.js';

const runningServers: HTTPServer[] = [];
const cleanupCallbacks: Array<() => Promise<void>> = [];

function createMockBackend(): any {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

async function startMcpEndpoint(options: MCPHTTPOptions) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const cleanup = mountMCPEndpoints(app, createMockBackend(), options);
  cleanupCallbacks.push(cleanup);

  const server = await new Promise<HTTPServer>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  runningServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/mcp`;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function initializeBody(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'gitnexus-http-test', version: '0.0.0' },
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(cleanupCallbacks.splice(0).map((cleanup) => cleanup()));
  await Promise.allSettled(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('MCP HTTP exposure defaults', () => {
  it('classifies only explicit loopback bind addresses as local', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.42')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('devbox.internal')).toBe(false);
  });

  it('keeps loopback read/write but makes remote access read-only by default', () => {
    const local = resolveMCPHTTPOptions('127.0.0.1', {}, {});
    const remote = resolveMCPHTTPOptions('0.0.0.0', {}, {});

    expect(local).toMatchObject({ remoteAccess: false, allowMutatingTools: true });
    expect(remote).toMatchObject({
      remoteAccess: true,
      allowInsecure: false,
      allowMutatingTools: false,
    });
    expect(remote.bearerToken).toBeUndefined();
  });

  it('requires explicit, separate opt-ins for remote insecure access and mutations', () => {
    const resolved = resolveMCPHTTPOptions(
      '0.0.0.0',
      {},
      {
        GITNEXUS_MCP_INSECURE: '1',
        GITNEXUS_MCP_ALLOW_MUTATIONS: 'true',
      },
    );

    expect(resolved.allowInsecure).toBe(true);
    expect(resolved.allowMutatingTools).toBe(true);
  });
});

describe('/api/mcp security and limits', () => {
  it('fails closed when a remote listener has no token or insecure opt-in', async () => {
    const url = await startMcpEndpoint({
      remoteAccess: true,
      bearerToken: '',
      allowInsecure: false,
    });

    const response = await postJson(url, initializeBody(1));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('Remote MCP is disabled') },
    });
  });

  it('accepts only a valid bearer token when one is configured', async () => {
    const url = await startMcpEndpoint({
      remoteAccess: true,
      bearerToken: 'unit-test-secret-token',
    });

    const missing = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');

    const wrong = await postJson(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { authorization: 'Bearer wrong-token' },
    );
    expect(wrong.status).toBe(401);

    const valid = await postJson(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { authorization: 'Bearer unit-test-secret-token' },
    );
    expect(valid.status).toBe(400);
    await expect(valid.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('initialize') },
    });
  });

  it('enforces the per-client request budget', async () => {
    const url = await startMcpEndpoint({
      bearerToken: '',
      maxRequestsPerMinute: 1,
    });

    const first = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(first.status).toBe(400);
    const second = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
  });

  it('rejects oversized MCP payloads before transport allocation', async () => {
    const url = await startMcpEndpoint({ bearerToken: '', maxRequestBytes: 1024 });
    const response = await postJson(url, {
      ...initializeBody(1),
      padding: 'x'.repeat(1500),
    });

    expect(response.status).toBe(413);
  });

  it('caps concurrent live sessions', async () => {
    const url = await startMcpEndpoint({ bearerToken: '', maxSessions: 1 });
    const first = await postJson(url, initializeBody(1));
    expect(first.status).toBe(200);
    const firstSessionId = first.headers.get('mcp-session-id');
    expect(firstSessionId).toBeTruthy();
    if (!firstSessionId) throw new Error('initialize response is missing mcp-session-id');

    const second = await postJson(url, initializeBody(2));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('session limit') },
    });

    const deleted = await fetch(url, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-session-id': firstSessionId,
      },
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await postJson(url, initializeBody(3));
    expect(afterDelete.status).toBe(200);
  });
});
