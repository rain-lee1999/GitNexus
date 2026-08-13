import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginRoot = path.join(packageRoot, 'codex-plugin');
const require = createRequire(import.meta.url);
const hook = require(path.join(pluginRoot, 'hooks', 'gitnexus-hook.cjs')) as {
  cliLaunch(
    command: string,
    args: string[],
    platform?: string,
    comSpec?: string,
  ): { command: string; args: string[] };
  extractSearchPattern(command: string): string | null;
  gitMutationTarget(command: string, cwd: string): { verb: string; cwd: string } | null;
  gitMutationVerb(command: string): string | null;
  handlePostToolUse(input: Record<string, unknown>): void;
  parseRefreshStatus(result: { stdout?: string } | null): Record<string, unknown> | null;
  runGitNexus(
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): { status: number | null; stdout?: string; error?: Error } | null;
};
const graphGate = require(path.join(pluginRoot, 'hooks', 'gitnexus-graph-gate.cjs')) as {
  handleGraphToolPreUse(input: Record<string, unknown>): void;
  isGatedGraphTool(toolName: string): boolean;
};
const gitHook = require(path.join(pluginRoot, 'hooks', 'gitnexus-git-hook.cjs')) as {
  cliLaunch(
    command: string,
    args: string[],
    platform?: string,
    comSpec?: string,
  ): { command: string; args: string[] };
  main(argv?: string[], cwd?: string): void;
  parseInvocation(argv: string[]): { event: string; gitArgs: string[] } | null;
  runGitNexus(args: string[], cwd: string): { status: number | null; error?: Error } | null;
  shouldMark(event: string, gitArgs: string[]): boolean;
};
const temporaryDirectories: string[] = [];
const originalGitNexusCli = process.env.GITNEXUS_CLI;
const originalRefreshStatus = process.env.GITNEXUS_TEST_REFRESH_STATUS;
const originalRefreshStatusCode = process.env.GITNEXUS_TEST_REFRESH_STATUS_CODE;
const originalRefreshLog = process.env.GITNEXUS_TEST_REFRESH_LOG;
const originalPath = process.env.PATH;
const originalPathCliLog = process.env.GITNEXUS_TEST_PATH_CLI_LOG;

type HookCommand = {
  type: string;
  command: string;
  timeout: number;
};

type HookEntry = {
  matcher: string;
  hooks: HookCommand[];
};

type HooksManifest = {
  hooks: {
    PreToolUse: HookEntry[];
    PostToolUse: HookEntry[];
  };
};

type PluginManifest = {
  skills: string;
  mcpServers: string;
  hooks: string;
};

type MarketplaceManifest = {
  name: string;
  plugins: unknown[];
};

type McpManifest = {
  gitnexus: {
    command: string;
    args: string[];
  };
};

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(pluginRoot, relativePath), 'utf8')) as T;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalGitNexusCli === undefined) delete process.env.GITNEXUS_CLI;
  else process.env.GITNEXUS_CLI = originalGitNexusCli;
  if (originalRefreshStatus === undefined) delete process.env.GITNEXUS_TEST_REFRESH_STATUS;
  else process.env.GITNEXUS_TEST_REFRESH_STATUS = originalRefreshStatus;
  if (originalRefreshStatusCode === undefined) delete process.env.GITNEXUS_TEST_REFRESH_STATUS_CODE;
  else process.env.GITNEXUS_TEST_REFRESH_STATUS_CODE = originalRefreshStatusCode;
  if (originalRefreshLog === undefined) delete process.env.GITNEXUS_TEST_REFRESH_LOG;
  else process.env.GITNEXUS_TEST_REFRESH_LOG = originalRefreshLog;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPathCliLog === undefined) delete process.env.GITNEXUS_TEST_PATH_CLI_LOG;
  else process.env.GITNEXUS_TEST_PATH_CLI_LOG = originalPathCliLog;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFakeRefreshCli(
  directory: string,
): Promise<{ cliPath: string; logPath: string }> {
  const cliPath = path.join(directory, 'fake-gitnexus-refresh.cjs');
  const logPath = path.join(directory, 'refresh-calls.jsonl');
  await writeFile(
    cliPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.GITNEXUS_TEST_REFRESH_LOG) {
  fs.appendFileSync(process.env.GITNEXUS_TEST_REFRESH_LOG, JSON.stringify(args) + '\\n');
}
if (args[0] === 'refresh' && args[1] === 'status') {
  process.stdout.write(process.env.GITNEXUS_TEST_REFRESH_STATUS || '');
  process.exit(Number(process.env.GITNEXUS_TEST_REFRESH_STATUS_CODE || '0'));
}
if (args[0] === 'refresh' && args[1] === 'mark') process.exit(0);
process.exit(1);
`,
    'utf8',
  );
  await chmod(cliPath, 0o755);
  return { cliPath, logPath };
}

async function readRefreshCalls(logPath: string): Promise<string[][]> {
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

async function loadCachedPluginHook(directory: string) {
  const cachedPluginRoot = path.join(
    directory,
    'plugin-cache',
    'gitnexus',
    '1.6.3',
    'codex-plugin',
  );
  const cachedHooksDirectory = path.join(cachedPluginRoot, 'hooks');
  const cachedHookPath = path.join(cachedHooksDirectory, 'gitnexus-hook.cjs');
  await mkdir(cachedHooksDirectory, { recursive: true });
  await writeFile(
    cachedHookPath,
    await readFile(path.join(pluginRoot, 'hooks', 'gitnexus-hook.cjs'), 'utf8'),
    'utf8',
  );

  return {
    cachedPluginRoot,
    hook: require(cachedHookPath) as typeof hook,
  };
}

async function loadCachedGraphGate(directory: string) {
  const cachedPluginRoot = path.join(
    directory,
    'plugin-cache',
    'gitnexus',
    '1.6.3',
    'codex-plugin',
  );
  const cachedHooksDirectory = path.join(cachedPluginRoot, 'hooks');
  const cachedHookPath = path.join(cachedHooksDirectory, 'gitnexus-hook.cjs');
  const cachedGatePath = path.join(cachedHooksDirectory, 'gitnexus-graph-gate.cjs');
  await mkdir(cachedHooksDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      cachedHookPath,
      await readFile(path.join(pluginRoot, 'hooks', 'gitnexus-hook.cjs'), 'utf8'),
      'utf8',
    ),
    writeFile(
      cachedGatePath,
      await readFile(path.join(pluginRoot, 'hooks', 'gitnexus-graph-gate.cjs'), 'utf8'),
      'utf8',
    ),
  ]);

  return {
    cachedPluginRoot,
    gate: require(cachedGatePath) as typeof graphGate,
  };
}

async function loadCachedGitHook(directory: string) {
  const cachedPluginRoot = path.join(
    directory,
    'plugin-cache',
    'gitnexus',
    '1.6.3',
    'codex-plugin',
  );
  const cachedHooksDirectory = path.join(cachedPluginRoot, 'hooks');
  const cachedHookPath = path.join(cachedHooksDirectory, 'gitnexus-git-hook.cjs');
  await mkdir(cachedHooksDirectory, { recursive: true });
  await writeFile(
    cachedHookPath,
    await readFile(path.join(pluginRoot, 'hooks', 'gitnexus-git-hook.cjs'), 'utf8'),
    'utf8',
  );

  return {
    cachedPluginRoot,
    hook: require(cachedHookPath) as typeof gitHook,
  };
}

async function createPathGitNexusCli(
  directory: string,
): Promise<{ binDirectory: string; logPath: string }> {
  const binDirectory = path.join(directory, 'bin');
  const cliPath = path.join(binDirectory, 'gitnexus');
  const logPath = path.join(directory, 'path-gitnexus-calls.jsonl');
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    cliPath,
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.GITNEXUS_TEST_PATH_CLI_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('{"refreshRequired":false,"alias":"path-cli"}');
`,
    'utf8',
  );
  await chmod(cliPath, 0o755);
  return { binDirectory, logPath };
}

async function addGitToPath(binDirectory: string): Promise<void> {
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(
    path.join(binDirectory, 'git'),
    `#!/bin/sh\nexec ${JSON.stringify(gitPath)} \"$@\"\n`,
    'utf8',
  );
  await chmod(path.join(binDirectory, 'git'), 0o755);
}

describe('Codex plugin bundle', () => {
  it('is a self-contained marketplace with version-aligned components', async () => {
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const marketplace = await readJson<MarketplaceManifest>('.agents/plugins/marketplace.json');
    const manifest = await readJson<PluginManifest>('.codex-plugin/plugin.json');
    const mcp = await readJson<McpManifest>('.mcp.json');

    expect(packageJson.files).toContain('codex-plugin');
    expect(packageJson.scripts.version).toBe('node scripts/sync-codex-plugin-version.cjs --stage');
    expect(packageJson.scripts.prepack).toContain(
      'node scripts/sync-codex-plugin-version.cjs --check',
    );
    expect(marketplace.name).toBe('gitnexus');
    expect(marketplace.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'gitnexus',
          version: packageJson.version,
          source: { source: 'local', path: './' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        }),
      ]),
    );

    expect(manifest).toMatchObject({
      name: 'gitnexus',
      version: packageJson.version,
      skills: './skills/',
      mcpServers: './.mcp.json',
      hooks: './hooks/hooks.json',
    });
    expect(mcp.gitnexus).toEqual({
      command: 'npx',
      args: ['-y', `gitnexus@${packageJson.version}`, 'mcp'],
    });

    for (const componentPath of [manifest.skills, manifest.mcpServers, manifest.hooks]) {
      expect(componentPath.startsWith('./')).toBe(true);
    }
  });

  it('uses narrow graph-query gates alongside advisory Bash hooks', async () => {
    const hooks = await readJson<HooksManifest>('hooks/hooks.json');
    const script = await readFile(path.join(pluginRoot, 'hooks', 'gitnexus-hook.cjs'), 'utf8');
    const graphGateScript = await readFile(
      path.join(pluginRoot, 'hooks', 'gitnexus-graph-gate.cjs'),
      'utf8',
    );
    const gitHookScript = await readFile(
      path.join(pluginRoot, 'hooks', 'gitnexus-git-hook.cjs'),
      'utf8',
    );

    expect(Object.keys(hooks.hooks)).toEqual(['PreToolUse', 'PostToolUse']);
    expect(hooks.hooks.PreToolUse).toHaveLength(2);
    expect(hooks.hooks.PreToolUse[0]).toMatchObject({ matcher: '^Bash$' });
    expect(hooks.hooks.PreToolUse[1]).toMatchObject({
      matcher:
        '^mcp__gitnexus__(query|cypher|context|impact|route_map|tool_map|shape_check|api_impact)$',
      hooks: [
        expect.objectContaining({
          command: expect.stringContaining('gitnexus-graph-gate.cjs'),
        }),
      ],
    });
    expect(hooks.hooks.PostToolUse).toEqual([expect.objectContaining({ matcher: '^Bash$' })]);
    for (const entry of [...hooks.hooks.PreToolUse, ...hooks.hooks.PostToolUse]) {
      expect(entry.hooks).toEqual([
        expect.objectContaining({
          type: 'command',
          command: expect.stringContaining('${PLUGIN_ROOT}'),
          timeout: 10,
        }),
      ]);
    }
    expect(script).toContain('input.tool_response');
    expect(script).not.toContain('input.tool_output');
    expect(script).toContain('hookSpecificOutput');
    expect(script).toContain('Shared only with gitnexus-graph-gate.cjs');
    expect(script).toContain("['refresh', 'mark'");
    expect(graphGateScript).toContain("['refresh', 'status'");
    expect(graphGateScript).toContain("permissionDecision: 'deny'");
    expect(graphGateScript).not.toContain("['refresh', 'request'");
    expect(graphGateScript).not.toContain("['refresh', 'ensure'");
    expect(graphGateScript).toContain('did not start or queue a refresh');
    expect(graphGateScript).toContain('$GITNEXUS_HOME');
    expect(script).not.toContain('npx');
    expect(graphGateScript).not.toContain('npx');
    expect(gitHookScript).not.toContain('npx');
  });

  it('bundles a directly discoverable Codex skill', async () => {
    const skill = await readFile(
      path.join(pluginRoot, 'skills', 'gitnexus-code-intelligence', 'SKILL.md'),
      'utf8',
    );

    expect(skill).toMatch(/^---\nname: gitnexus-code-intelligence\n/);
    expect(skill).toContain('description:');
    expect(skill).toContain('impact');
    expect(skill).toContain('detect_changes');
  });
});

describe('Codex hook behavior', () => {
  it('uses PATH from a plugin-cache layout without a bundled dist CLI', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-cache-cli-'));
    temporaryDirectories.push(directory);
    const { cachedPluginRoot, hook: cachedHook } = await loadCachedPluginHook(directory);
    const { binDirectory, logPath } = await createPathGitNexusCli(directory);
    const relativeCliPath = path.join(directory, 'relative-gitnexus');
    await writeFile(
      relativeCliPath,
      `#!${process.execPath}\nprocess.stdout.write('relative-cli');\n`,
      'utf8',
    );
    await chmod(relativeCliPath, 0o755);

    // A real installed plugin contains the plugin bundle but not the package
    // root's dist/cli/index.js. A relative override must not become an
    // ambiguous substitute for the installed CLI.
    await expect(
      readFile(path.join(cachedPluginRoot, '..', 'dist', 'cli', 'index.js')),
    ).rejects.toThrow();
    process.env.GITNEXUS_CLI = './relative-gitnexus';
    process.env.PATH = binDirectory;
    process.env.GITNEXUS_TEST_PATH_CLI_LOG = logPath;

    const result = cachedHook.runGitNexus(['refresh', 'status', '--json'], directory, 2_000);

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain('"alias":"path-cli"');
    expect(await readRefreshCalls(logPath)).toEqual([['refresh', 'status', '--json']]);
  });

  it('fails closed without repo pollution when a cached graph gate cannot find GitNexus on PATH', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-cache-missing-cli-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const { gate: cachedGate } = await loadCachedGraphGate(directory);
    const binDirectory = path.join(directory, 'bin-without-gitnexus');
    await mkdir(binDirectory, { recursive: true });
    await addGitToPath(binDirectory);
    delete process.env.GITNEXUS_CLI;
    process.env.PATH = binDirectory;

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    cachedGate.handleGraphToolPreUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__gitnexus__query',
      cwd: directory,
      tool_input: { query: 'cache resolver', repo: directory },
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('freshness could not be verified'),
        additionalContext: expect.stringContaining('put `gitnexus` on PATH'),
      },
    });
    await expect(stat(path.join(directory, '.gitnexus'))).rejects.toThrow();
  });

  it('uses PATH from a plugin-cache layout for the standalone Git hook template', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-cached-git-hook-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const { cachedPluginRoot, hook: cachedGitHook } = await loadCachedGitHook(directory);
    const { binDirectory, logPath } = await createPathGitNexusCli(directory);
    await addGitToPath(binDirectory);
    delete process.env.GITNEXUS_CLI;
    process.env.PATH = binDirectory;
    process.env.GITNEXUS_TEST_PATH_CLI_LOG = logPath;

    await expect(
      readFile(path.join(cachedPluginRoot, '..', 'dist', 'cli', 'index.js')),
    ).rejects.toThrow();
    cachedGitHook.main(['--event', 'post-commit'], directory);

    expect(await readRefreshCalls(logPath)).toEqual([
      expect.arrayContaining(['refresh', 'mark', '--reason', 'git-post-commit']),
    ]);
  });

  it('keeps the standalone Git hook fail-open when the cached plugin has no CLI', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-cached-git-hook-missing-cli-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const { hook: cachedGitHook } = await loadCachedGitHook(directory);
    const binDirectory = path.join(directory, 'bin-without-gitnexus');
    await mkdir(binDirectory, { recursive: true });
    await addGitToPath(binDirectory);
    delete process.env.GITNEXUS_CLI;
    process.env.PATH = binDirectory;

    expect(() => cachedGitHook.main(['--event', 'post-commit'], directory)).not.toThrow();
    await expect(stat(path.join(directory, '.gitnexus'))).rejects.toThrow();
  });

  it('extracts bounded rg and grep patterns without invoking a shell', () => {
    expect(hook.extractSearchPattern('rg -n "createMCPServer" gitnexus/src')).toBe(
      'createMCPServer',
    );
    expect(hook.extractSearchPattern("grep -R -e 'session limit' .")).toBe('session limit');
    expect(hook.extractSearchPattern('git status')).toBeNull();
    expect(hook.extractSearchPattern(`rg ${'x'.repeat(201)}`)).toBeNull();
  });

  it('uses an argv-safe cmd.exe launcher for Windows command shims', () => {
    const args = [
      'refresh',
      'mark',
      '--path',
      'C:\\worktrees\\safe & intact',
      '--reason',
      'git-commit',
    ];
    const expected = {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\Program Files\\GitNexus\\gitnexus.cmd', ...args],
    };

    expect(
      hook.cliLaunch(
        'C:\\Program Files\\GitNexus\\gitnexus.cmd',
        args,
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual(expected);
    expect(
      gitHook.cliLaunch(
        'C:\\Program Files\\GitNexus\\gitnexus.cmd',
        args,
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual(expected);
    expect(hook.cliLaunch('gitnexus', args, 'linux')).toEqual({ command: 'gitnexus', args });
  });

  it('recognizes history-changing git commands including -C', () => {
    expect(hook.gitMutationVerb('git commit -m test')).toBe('commit');
    expect(hook.gitMutationVerb('git -C /tmp/repo rebase main')).toBe('rebase');
    expect(hook.gitMutationVerb('git reset --hard HEAD~1')).toBe('reset');
    expect(hook.gitMutationVerb('git status')).toBeNull();
  });

  it("routes a git -C mutation marker to Git's effective worktree", async () => {
    const callingDirectory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-calling-worktree-'));
    const targetDirectory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-target-worktree-'));
    temporaryDirectories.push(callingDirectory, targetDirectory);
    execFileSync('git', ['init', '-q'], { cwd: callingDirectory });
    execFileSync('git', ['init', '-q'], { cwd: targetDirectory });
    const canonicalTarget = await realpath(targetDirectory);
    const { cliPath, logPath } = await createFakeRefreshCli(callingDirectory);
    process.env.GITNEXUS_CLI = cliPath;
    process.env.GITNEXUS_TEST_REFRESH_LOG = logPath;

    expect(
      hook.gitMutationTarget(
        `git -C ${JSON.stringify(targetDirectory)} commit -m target`,
        callingDirectory,
      ),
    ).toEqual({ verb: 'commit', cwd: path.resolve(targetDirectory) });

    hook.handlePostToolUse({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      cwd: callingDirectory,
      tool_input: { command: `git -C ${JSON.stringify(targetDirectory)} commit -m target` },
      tool_response: { exit_code: 0 },
    });

    expect(await readRefreshCalls(logPath)).toEqual([
      expect.arrayContaining([
        'refresh',
        'mark',
        '--path',
        canonicalTarget,
        '--reason',
        'git-commit',
      ]),
    ]);
  });

  it('uses tool_response and emits a Codex PostToolUse stale-marker warning', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-hook-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'hook-test@example.com'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Hook Test'], { cwd: directory });
    await writeFile(path.join(directory, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: directory });
    const indexedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();
    await mkdir(path.join(directory, '.gitnexus'));
    await writeFile(
      path.join(directory, '.gitnexus', 'meta.json'),
      JSON.stringify({ lastCommit: indexedCommit }),
    );
    await writeFile(path.join(directory, 'tracked.txt'), 'two\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: directory });
    const canonicalDirectory = await realpath(directory);
    const { cliPath, logPath } = await createFakeRefreshCli(directory);
    process.env.GITNEXUS_CLI = cliPath;
    process.env.GITNEXUS_TEST_REFRESH_LOG = logPath;

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    hook.handlePostToolUse({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      cwd: directory,
      tool_input: { command: 'git commit -m second' },
      tool_response: { exit_code: 0 },
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: expect.stringContaining('does not authorize a refresh'),
      },
    });
    expect(await readRefreshCalls(logPath)).toEqual([
      expect.arrayContaining([
        'refresh',
        'mark',
        '--path',
        canonicalDirectory,
        '--reason',
        'git-commit',
      ]),
    ]);

    writes.length = 0;
    hook.handlePostToolUse({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      cwd: directory,
      tool_input: { command: 'git commit -m failed' },
      tool_response: { exit_code: 1 },
    });
    expect(writes).toHaveLength(0);
    expect(await readRefreshCalls(logPath)).toHaveLength(1);
  });

  it('fails closed for a stale graph query after status only, without queuing or running refresh', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-gate-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const canonicalDirectory = await realpath(directory);
    const { cliPath, logPath } = await createFakeRefreshCli(directory);
    process.env.GITNEXUS_CLI = cliPath;
    process.env.GITNEXUS_TEST_REFRESH_LOG = logPath;
    process.env.GITNEXUS_TEST_REFRESH_STATUS = JSON.stringify({
      refreshRequired: true,
      reason: 'head-mismatch',
      staleMarkerCount: 0,
      alias: 'test-worktree',
    });
    process.env.GITNEXUS_TEST_REFRESH_STATUS_CODE = '2';

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    graphGate.handleGraphToolPreUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__gitnexus__impact',
      cwd: directory,
      tool_input: { target: 'main', direction: 'upstream', repo: canonicalDirectory },
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'head-mismatch',
        additionalContext: expect.stringContaining('gitnexus refresh ensure'),
      },
    });
    const calls = await readRefreshCalls(logPath);
    expect(JSON.parse(writes[0])).toMatchObject({
      hookSpecificOutput: {
        additionalContext: expect.stringContaining('did not start or queue a refresh'),
      },
    });
    expect(calls).toEqual([
      expect.arrayContaining(['refresh', 'status', '--path', canonicalDirectory, '--json']),
    ]);
    expect(calls.flat()).not.toContain('request');
    expect(calls.flat()).not.toContain('ensure');
    expect(calls.flat()).not.toContain('analyze');
  });

  it('allows a fresh graph query and excludes detect_changes and mutating tools from the gate', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-fresh-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const canonicalDirectory = await realpath(directory);
    const { cliPath, logPath } = await createFakeRefreshCli(directory);
    process.env.GITNEXUS_CLI = cliPath;
    process.env.GITNEXUS_TEST_REFRESH_LOG = logPath;
    process.env.GITNEXUS_TEST_REFRESH_STATUS = JSON.stringify({
      refreshRequired: false,
      alias: 'test-worktree',
    });

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    graphGate.handleGraphToolPreUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__gitnexus__context',
      cwd: directory,
      tool_input: { name: 'main', repo: canonicalDirectory },
    });

    expect(writes).toEqual([]);
    expect(await readRefreshCalls(logPath)).toEqual([
      expect.arrayContaining(['refresh', 'status', '--path', canonicalDirectory, '--json']),
    ]);
    expect(graphGate.isGatedGraphTool('mcp__gitnexus__detect_changes')).toBe(false);
    expect(graphGate.isGatedGraphTool('mcp__gitnexus__list_repos')).toBe(false);
    expect(graphGate.isGatedGraphTool('mcp__gitnexus__group_list')).toBe(false);
    expect(graphGate.isGatedGraphTool('mcp__gitnexus__group_sync')).toBe(false);
    expect(graphGate.isGatedGraphTool('mcp__gitnexus__rename')).toBe(false);
    expect(hook.parseRefreshStatus({ stdout: '{"refreshRequired":false}' })).toEqual({
      refreshRequired: false,
    });
  });

  it('fails closed before status when a graph query omits repo', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-missing-repo-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const { cliPath, logPath } = await createFakeRefreshCli(directory);
    process.env.GITNEXUS_CLI = cliPath;
    process.env.GITNEXUS_TEST_REFRESH_LOG = logPath;

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    graphGate.handleGraphToolPreUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__gitnexus__query',
      cwd: directory,
      tool_input: { query: 'refresh coordinator' },
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('must include `repo`'),
      },
    });
    expect(await readRefreshCalls(logPath)).toEqual([]);
  });

  it('fails closed before status when a graph query uses a registry alias', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-codex-alias-rejected-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const { cliPath, logPath } = await createFakeRefreshCli(directory);
    process.env.GITNEXUS_CLI = cliPath;
    process.env.GITNEXUS_TEST_REFRESH_LOG = logPath;

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    graphGate.handleGraphToolPreUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__gitnexus__query',
      cwd: directory,
      tool_input: { query: 'refresh coordinator', repo: 'current-worktree-alias' },
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('only an absolute `repo`'),
      },
    });
    expect(await readRefreshCalls(logPath)).toEqual([]);
  });

  it('ships a fail-open Git hook template that only marks branch-changing events', async () => {
    expect(gitHook.parseInvocation(['--event', 'post-merge', '0'])).toEqual({
      event: 'post-merge',
      gitArgs: ['0'],
    });
    expect(gitHook.shouldMark('post-checkout', ['old', 'new', '0'])).toBe(false);
    expect(gitHook.shouldMark('post-checkout', ['old', 'new', '1'])).toBe(true);

    const directory = await mkdtemp(path.join(tmpdir(), 'gitnexus-git-hook-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const canonicalDirectory = await realpath(directory);
    const { cliPath, logPath } = await createFakeRefreshCli(directory);
    process.env.GITNEXUS_CLI = cliPath;
    process.env.GITNEXUS_TEST_REFRESH_LOG = logPath;

    gitHook.main(['--event', 'post-commit'], directory);

    expect(await readRefreshCalls(logPath)).toEqual([
      expect.arrayContaining([
        'refresh',
        'mark',
        '--path',
        canonicalDirectory,
        '--reason',
        'git-post-commit',
      ]),
    ]);
  });
});
