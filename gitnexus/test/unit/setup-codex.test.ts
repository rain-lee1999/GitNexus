import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageSpecifier = `gitnexus@${(require('../../package.json') as { version: string }).version}`;

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const execFile = (...args: any[]) => execFileMock(...args);
  (execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = (...args: any[]) =>
    new Promise((resolve, reject) => {
      execFileMock(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  return {
    ...(await importOriginal<typeof import('child_process')>()),
    execFile,
    execFileSync: execFileSyncMock,
  };
});

const pluginEntry = {
  command: 'npx',
  args: ['-y', packageSpecifier, 'mcp'],
};
const platformPluginEntry =
  process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', pluginEntry.command, ...pluginEntry.args] }
    : pluginEntry;

function registration(entry = pluginEntry) {
  return JSON.stringify({
    name: 'gitnexus',
    enabled: true,
    transport: { type: 'stdio', command: entry.command, args: entry.args },
  });
}

function completeExecFile(stdout = '') {
  return (...args: any[]) => {
    const callback = args.at(-1);
    callback(null, stdout, '');
  };
}

describe('Codex setup', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalCodexHome = process.env.CODEX_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-codex-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.CODEX_HOME;

    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'codex') return '/usr/local/bin/codex\n';
      throw new Error('not found');
    });
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs[0] === 'plugin') return callback(null, '{}', '');
      if (cliArgs[0] === 'mcp' && cliArgs[1] === 'get') {
        return callback(null, registration(), '');
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('uses the bundled plugin as the primary user-scope path', async () => {
    const { getCodexPluginBundlePath, setupCommand } = await import('../../src/cli/setup.js');
    const bundlePath = await fs.realpath(getCodexPluginBundlePath());
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs.slice(0, 3).join(' ') === 'plugin marketplace list') {
        return callback(
          null,
          JSON.stringify({
            marketplaces: [
              {
                name: 'gitnexus',
                root: bundlePath,
                marketplaceSource: { sourceType: 'local', source: bundlePath },
              },
            ],
          }),
          '',
        );
      }
      if (cliArgs[0] === 'plugin') return callback(null, '{}', '');
      if (cliArgs[0] === 'mcp' && cliArgs[1] === 'get') {
        return callback(null, registration(), '');
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });

    const result = await setupCommand();

    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['plugin', 'marketplace', 'add', bundlePath, '--json'],
      expect.objectContaining({ shell: process.platform === 'win32' }),
      expect.any(Function),
    );
    expect(execFileMock).not.toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['plugin', 'marketplace', 'remove', 'gitnexus', '--json'],
      expect.objectContaining({ shell: process.platform === 'win32' }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['plugin', 'add', 'gitnexus@gitnexus', '--json'],
      expect.objectContaining({ shell: process.platform === 'win32' }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['mcp', 'get', 'gitnexus', '--json'],
      expect.objectContaining({ shell: process.platform === 'win32' }),
      expect.any(Function),
    );
    expect(execFileMock).not.toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.arrayContaining(['mcp', 'add']),
      expect.anything(),
      expect.any(Function),
    );
    await expect(fs.access(path.join(tempHome, '.codex'))).resolves.toBeUndefined();
    expect(result.configured).toContain('Codex plugin (hooks, workflow skill, MCP)');
  });

  it('replaces a gitnexus marketplace only when its local source changed', async () => {
    const { getCodexPluginBundlePath, setupCommand } = await import('../../src/cli/setup.js');
    const bundlePath = await fs.realpath(getCodexPluginBundlePath());
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs.slice(0, 3).join(' ') === 'plugin marketplace list') {
        return callback(
          null,
          JSON.stringify({
            marketplaces: [
              {
                name: 'gitnexus',
                root: '/tmp/old-npx-cache/gitnexus/codex-plugin',
                marketplaceSource: {
                  sourceType: 'local',
                  source: '/tmp/old-npx-cache/gitnexus/codex-plugin',
                },
              },
            ],
          }),
          '',
        );
      }
      if (cliArgs[0] === 'plugin') return callback(null, '{}', '');
      if (cliArgs[0] === 'mcp' && cliArgs[1] === 'get') {
        return callback(null, registration(), '');
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });

    const result = await setupCommand();
    const calls = execFileMock.mock.calls.map((call) => call[1] as string[]);
    const removeIndex = calls.findIndex(
      (args) => args.join(' ') === 'plugin marketplace remove gitnexus --json',
    );
    const addIndex = calls.findIndex(
      (args) => args.join(' ') === `plugin marketplace add ${bundlePath} --json`,
    );

    expect(removeIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(removeIndex);
    expect(result.configured).toContain('Codex plugin (hooks, workflow skill, MCP)');
  });

  it('removes a stale explicit MCP table so the plugin entry is not shadowed', async () => {
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `model = "gpt-5"\n\n[mcp_servers.gitnexus]\ncommand = "npx"\nargs = ["-y", "gitnexus@latest", "mcp"]\ntool_timeout_sec = 99\n\n[mcp_servers.keep]\nurl = "https://example.invalid/mcp"\n`,
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    const result = await setupCommand();

    const next = await fs.readFile(configPath, 'utf-8');
    expect(next).not.toContain('[mcp_servers.gitnexus]');
    expect(next).not.toContain('gitnexus@latest');
    expect(next).toContain('model = "gpt-5"');
    expect(next).toContain('[mcp_servers.keep]');
    expect(next).toContain('url = "https://example.invalid/mcp"');
    expect(result.warnings).toEqual([]);
  });

  it('falls back to direct MCP registration when the plugin CLI is unavailable', async () => {
    let activeRegistration = registration();
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs[0] === 'plugin') return callback(new Error('unknown command plugin'), '', '');
      if (cliArgs[0] === 'mcp' && cliArgs[1] === 'add') {
        const separator = cliArgs.indexOf('--');
        if (separator < 0) throw new Error(`missing MCP command separator: ${cliArgs.join(' ')}`);
        activeRegistration = registration({
          command: cliArgs[separator + 1],
          args: cliArgs.slice(separator + 2),
        });
        return callback(null, '', '');
      }
      if (cliArgs[0] === 'mcp' && cliArgs[1] === 'get') {
        return callback(null, activeRegistration, '');
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    const result = await setupCommand();

    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['mcp', 'add', 'gitnexus', '--', platformPluginEntry.command, ...platformPluginEntry.args],
      expect.objectContaining({ shell: process.platform === 'win32' }),
      expect.any(Function),
    );
    expect(result.configured).toContain('Codex (direct MCP fallback)');
    expect(result.warnings.join('\n')).toContain('Codex plugin unavailable');
  });

  it('uses CODEX_HOME and works without a pre-existing Codex directory', async () => {
    const customCodexHome = path.join(tempHome, 'custom-codex-home');
    process.env.CODEX_HOME = customCodexHome;
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    execFileMock.mockImplementation(completeExecFile());

    const { setupCommand } = await import('../../src/cli/setup.js');
    const result = await setupCommand();

    const config = await fs.readFile(path.join(customCodexHome, 'config.toml'), 'utf-8');
    expect(config).toContain('[mcp_servers.gitnexus]');
    expect(config).toContain(packageSpecifier);
    await expect(
      fs.access(path.join(tempHome, '.agents', 'skills', 'gitnexus-cli', 'SKILL.md')),
    ).resolves.toBeUndefined();
    expect(result.warnings.join('\n')).toContain('Codex CLI was not found');
  });

  it('keeps project setup local and does not install a user-scoped plugin', async () => {
    const projectRoot = path.join(tempHome, 'repo');
    await fs.mkdir(projectRoot, { recursive: true });
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs[0] === 'mcp' && cliArgs[1] === 'get') {
        return callback(new Error('project is not trusted'), '', '');
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    const result = await setupCommand({ codexScope: 'project', projectRoot });

    const config = await fs.readFile(path.join(projectRoot, '.codex', 'config.toml'), 'utf-8');
    expect(config).toContain('[mcp_servers.gitnexus]');
    expect(config).toContain(packageSpecifier);
    await expect(
      fs.access(path.join(projectRoot, '.agents', 'skills', 'gitnexus-cli', 'SKILL.md')),
    ).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.arrayContaining(['plugin']),
      expect.anything(),
      expect.any(Function),
    );
    expect(result.warnings.join('\n')).toContain('trust the project');
  });
});

describe('Codex TOML editing and path resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-codex-toml-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not persist an ephemeral npx cache binary', async () => {
    execFileSyncMock.mockReturnValue(
      '/Users/example/.npm/_npx/9a1b2c3d/node_modules/.bin/gitnexus\n',
    );

    const { getMcpEntry } = await import('../../src/cli/setup.js');

    expect(getMcpEntry()).toEqual(platformPluginEntry);
  });

  it('updates command and args while preserving unknown fields and other TOML tables', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    const original = `model = "gpt-5"\n\n[mcp_servers.gitnexus]\ncommand = "old"\nargs = ["old"]\nenabled = false\nenabled_tools = ["query"]\n\n[mcp_servers.other]\ncommand = "keep"\nargs = ["unchanged"]\n`;
    await fs.writeFile(configPath, original, 'utf-8');

    const { upsertCodexConfigToml } = await import('../../src/cli/setup.js');
    await upsertCodexConfigToml(configPath, { command: 'new-bin', args: ['mcp', '--flag'] });

    const next = await fs.readFile(configPath, 'utf-8');
    expect(next).toContain('command = "new-bin"');
    expect(next).toContain('args = ["mcp", "--flag"]');
    expect(next).toContain('enabled = false');
    expect(next).toContain('enabled_tools = ["query"]');
    expect(next).toContain('[mcp_servers.other]\ncommand = "keep"\nargs = ["unchanged"]');
  });

  it('recognizes a quoted GitNexus table and does not append a duplicate', async () => {
    const configPath = path.join(tempDir, 'config.toml');
    await fs.writeFile(
      configPath,
      `[mcp_servers."gitnexus"]\ncommand = "old"\ncustom = "keep"\n`,
      'utf-8',
    );

    const { upsertCodexConfigToml } = await import('../../src/cli/setup.js');
    await upsertCodexConfigToml(configPath, { command: 'new-bin', args: ['mcp'] });

    const next = await fs.readFile(configPath, 'utf-8');
    expect(next.match(/mcp_servers\./g)).toHaveLength(1);
    expect(next).toContain('command = "new-bin"');
    expect(next).toContain('args = ["mcp"]');
    expect(next).toContain('custom = "keep"');
  });
});
