import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginRoot = path.join(packageRoot, 'codex-plugin');
const require = createRequire(import.meta.url);
const hook = require(path.join(pluginRoot, 'hooks', 'gitnexus-hook.cjs')) as {
  extractSearchPattern(command: string): string | null;
  gitMutationVerb(command: string): string | null;
  handlePostToolUse(input: Record<string, unknown>): void;
};
const temporaryDirectories: string[] = [];

async function readJson(relativePath: string): Promise<any> {
  return JSON.parse(await readFile(path.join(pluginRoot, relativePath), 'utf8'));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Codex plugin bundle', () => {
  it('is a self-contained marketplace with version-aligned components', async () => {
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const marketplace = await readJson('.agents/plugins/marketplace.json');
    const manifest = await readJson('.codex-plugin/plugin.json');
    const mcp = await readJson('.mcp.json');

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

  it('uses the current Codex PreToolUse and PostToolUse schema', async () => {
    const hooks = await readJson('hooks/hooks.json');
    const script = await readFile(path.join(pluginRoot, 'hooks', 'gitnexus-hook.cjs'), 'utf8');

    expect(Object.keys(hooks.hooks)).toEqual(['PreToolUse', 'PostToolUse']);
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(hooks.hooks[event]).toEqual([
        expect.objectContaining({
          matcher: '^Bash$',
          hooks: [
            expect.objectContaining({
              type: 'command',
              command: expect.stringContaining('${PLUGIN_ROOT}'),
              timeout: 10,
            }),
          ],
        }),
      ]);
    }
    expect(script).toContain('input.tool_response');
    expect(script).not.toContain('input.tool_output');
    expect(script).toContain('hookSpecificOutput');
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
  it('extracts bounded rg and grep patterns without invoking a shell', () => {
    expect(hook.extractSearchPattern('rg -n "createMCPServer" gitnexus/src')).toBe(
      'createMCPServer',
    );
    expect(hook.extractSearchPattern("grep -R -e 'session limit' .")).toBe('session limit');
    expect(hook.extractSearchPattern('git status')).toBeNull();
    expect(hook.extractSearchPattern(`rg ${'x'.repeat(201)}`)).toBeNull();
  });

  it('recognizes history-changing git commands including -C', () => {
    expect(hook.gitMutationVerb('git commit -m test')).toBe('commit');
    expect(hook.gitMutationVerb('git -C /tmp/repo rebase main')).toBe('rebase');
    expect(hook.gitMutationVerb('git status')).toBeNull();
  });

  it('uses tool_response and emits a Codex PostToolUse freshness warning', async () => {
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
        additionalContext: expect.stringContaining('npx gitnexus analyze'),
      },
    });

    writes.length = 0;
    hook.handlePostToolUse({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      cwd: directory,
      tool_input: { command: 'git commit -m failed' },
      tool_response: { exit_code: 1 },
    });
    expect(writes).toHaveLength(0);
  });
});
