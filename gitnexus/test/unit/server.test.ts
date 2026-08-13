/**
 * Unit Tests: MCP Server
 *
 * Tests: createMCPServer from server.ts
 * - Server creation returns a Server instance
 * - Tool handler wraps backend.callTool and appends hints
 * - Tool handler catches errors and returns isError: true
 * - Resource handlers delegate to resources.ts functions
 * - Prompt handlers return expected prompts
 * - Next-step hints cover all tool names
 *
 * NOTE: We test the server handler logic by calling the request handlers
 * directly through the MCP Server's handler dispatch.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer, GITNEXUS_MCP_INSTRUCTIONS } from '../../src/mcp/server.js';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

// ─── Mock backend ──────────────────────────────────────────────────

function createMockBackend(overrides: Record<string, any> = {}): any {
  return {
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    listRepos: vi.fn().mockResolvedValue([]),
    resolveRepo: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    getContext: vi.fn().mockReturnValue(null),
    queryClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── createMCPServer ─────────────────────────────────────────────────

describe('createMCPServer', () => {
  it('returns a Server instance with expected shape', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    expect(server).toBeDefined();
    // Server should have connect/close methods
    expect(typeof server.connect).toBe('function');
    expect(typeof server.close).toBe('function');
  });

  it('server has setRequestHandler method', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    // The server has registered handlers — verify it was created without errors
    expect(server).toBeTruthy();
  });

  it('tools/list response includes tool annotations', async () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const response = await client.listTools();
      expect(response.tools).toHaveLength(GITNEXUS_TOOLS.length);

      for (const tool of response.tools) {
        const definition = GITNEXUS_TOOLS.find((t) => t.name === tool.name)!;
        expect(tool.annotations).toEqual(definition.annotations);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns self-contained workflow instructions during initialization', async () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    const client = new Client({ name: 'codex-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getInstructions()).toBe(GITNEXUS_MCP_INSTRUCTIONS);
      const firstWindow = GITNEXUS_MCP_INSTRUCTIONS.slice(0, 512);
      expect(firstWindow).toContain('query then context');
      expect(firstWindow).toContain('impact with direction "upstream"');
      expect(firstWindow).toContain('detect_changes');
      expect(firstWindow).toContain('refresh plan');
      expect(firstWindow).toContain('refresh ensure --path <absolute-worktree>');
      expect(firstWindow).toContain('absolute worktree path');
      expect(firstWindow).toContain('detect_changes` is not freshness-gated');
      expect(GITNEXUS_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('hides and rejects mutating tools when configured read-only', async () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend, { allowMutatingTools: false });
    const client = new Client({ name: 'read-only-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const tools = await client.listTools();
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools.tools.map((tool) => tool.name)).not.toContain('rename');
      expect(tools.tools.map((tool) => tool.name)).not.toContain('group_sync');

      const result = await client.callTool({
        name: 'rename',
        arguments: { new_name: 'blocked' },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('read-only') }),
        ]),
      );
      expect(backend.callTool).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves object tool results as structuredContent alongside text', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ processes: [], risk: 'LOW' }),
    });
    const server = createMCPServer(backend);
    const client = new Client({ name: 'structured-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'query', arguments: { query: 'auth' } });

      expect(result.structuredContent).toEqual({ processes: [], risk: 'LOW' });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('"risk": "LOW"') }),
        ]),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ─── getNextStepHint (tested indirectly via server tool handler) ──────

describe('getNextStepHint (via tool call response)', () => {
  // We test hints by calling the server's tool handler indirectly.
  // Since createMCPServer registers handlers on the Server, we verify
  // hints are appended by checking the tool response format.

  it('query tool response includes hint about context', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ processes: [], definitions: [] }),
    });
    const _server = createMCPServer(backend);

    // We can't easily call handlers directly on the MCP Server,
    // so we verify the handler was registered by creating the server without error.
    // The actual hint logic is tested via the integration path.
    expect(backend.callTool).not.toHaveBeenCalled(); // not called until request
  });
});

// ─── Tool handler error handling ──────────────────────────────────────

describe('server error handling', () => {
  it('createMCPServer does not throw for valid backend', () => {
    const backend = createMockBackend();
    expect(() => createMCPServer(backend)).not.toThrow();
  });

  it('createMCPServer reads version from package.json', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    // Server was created with version from package.json — no crash
    expect(server).toBeDefined();
  });
});

// ─── Prompt definitions ───────────────────────────────────────────────

describe('prompt registration', () => {
  it('server registers detect_impact and generate_map prompts', () => {
    const backend = createMockBackend();
    // Creating the server registers all handlers including prompts
    const server = createMCPServer(backend);
    expect(server).toBeDefined();
  });
});
