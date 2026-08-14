import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageSpecifier = `gitnexus@${(require('../../package.json') as { version: string }).version}`;

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

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
  };
});

const requiredSkills = [
  'gitnexus-exploring',
  'gitnexus-debugging',
  'gitnexus-impact-analysis',
  'gitnexus-refactoring',
  'gitnexus-pr-review',
  'gitnexus-guide',
  'gitnexus-cli',
];

const pluginRegistration = {
  name: 'gitnexus',
  enabled: true,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', packageSpecifier, 'mcp'],
  },
};

describe('doctor codex', () => {
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
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-doctor-codex-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CODEX_HOME = path.join(tempHome, 'isolated-codex');

    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, 'config.toml'),
      '[plugin_marketplaces.gitnexus]\nsource = "local"\n',
      'utf-8',
    );
    for (const skill of requiredSkills) {
      const skillDir = path.join(tempHome, '.agents', 'skills', skill);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${skill}\n`, 'utf-8');
    }

    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs[0] === '--version') return callback(null, 'codex-cli 0.144.6\n', '');
      if (cliArgs.join(' ') === 'plugin list --json') {
        return callback(
          null,
          JSON.stringify({
            installed: [{ pluginId: 'gitnexus@gitnexus', installed: true, enabled: true }],
          }),
          '',
        );
      }
      if (cliArgs.join(' ') === 'mcp get gitnexus --json') {
        return callback(null, JSON.stringify(pluginRegistration), '');
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('checks CLI, CODEX_HOME config, skills, plugin/hooks, and registration', async () => {
    const { runCodexDoctor } = await import('../../src/cli/doctor-codex.js');

    const report = await runCodexDoctor({ runProtocol: false });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Codex CLI', status: 'pass' }),
        expect.objectContaining({
          name: 'Codex config',
          status: 'pass',
          detail: path.join(process.env.CODEX_HOME!, 'config.toml'),
        }),
        expect.objectContaining({ name: 'Codex skills', status: 'pass' }),
        expect.objectContaining({ name: 'Codex plugin/hooks', status: 'pass' }),
        expect.objectContaining({ name: 'Codex MCP registration', status: 'pass' }),
      ]),
    );
  });

  it('fails when a stale user MCP entry shadows the installed plugin entry', async () => {
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs[0] === '--version') return callback(null, 'codex-cli 0.144.6\n', '');
      if (cliArgs.join(' ') === 'plugin list --json') {
        return callback(
          null,
          JSON.stringify({
            installed: [{ pluginId: 'gitnexus@gitnexus', installed: true, enabled: true }],
          }),
          '',
        );
      }
      if (cliArgs.join(' ') === 'mcp get gitnexus --json') {
        return callback(
          null,
          JSON.stringify({
            ...pluginRegistration,
            transport: {
              ...pluginRegistration.transport,
              args: ['-y', 'gitnexus@latest', 'mcp'],
            },
          }),
          '',
        );
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });

    const { runCodexDoctor } = await import('../../src/cli/doctor-codex.js');
    const report = await runCodexDoctor({ runProtocol: false });
    const registration = report.checks.find((check) => check.name === 'Codex MCP registration');

    expect(report.ok).toBe(false);
    expect(registration).toMatchObject({ status: 'fail' });
    expect(registration?.detail).toContain('shadowed or stale');
    expect(registration?.fix).toContain('gitnexus setup');
  });

  it('accepts an intentional direct local MCP override when the plugin is installed', async () => {
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs[0] === '--version') return callback(null, 'codex-cli 0.144.6\n', '');
      if (cliArgs.join(' ') === 'plugin list --json') {
        return callback(
          null,
          JSON.stringify({
            installed: [{ pluginId: 'gitnexus@gitnexus', installed: true, enabled: true }],
          }),
          '',
        );
      }
      if (cliArgs.join(' ') === 'mcp get gitnexus --json') {
        return callback(
          null,
          JSON.stringify({
            ...pluginRegistration,
            transport: { type: 'stdio', command: '/opt/homebrew/bin/gitnexus', args: ['mcp'] },
          }),
          '',
        );
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });

    const { runCodexDoctor } = await import('../../src/cli/doctor-codex.js');
    const report = await runCodexDoctor({ runProtocol: false });
    const registration = report.checks.find((check) => check.name === 'Codex MCP registration');

    expect(report.ok).toBe(true);
    expect(registration).toMatchObject({
      status: 'pass',
      detail: '/opt/homebrew/bin/gitnexus mcp (direct local override)',
    });
  });

  it('keeps a direct MCP fallback healthy when the plugin CLI is unavailable', async () => {
    execFileMock.mockImplementation((...args: any[]) => {
      const cliArgs = args[1] as string[];
      const callback = args.at(-1);
      if (cliArgs[0] === '--version') return callback(null, 'codex-cli 0.140.0\n', '');
      if (cliArgs.join(' ') === 'plugin list --json') {
        return callback(new Error('unknown command plugin'), '', '');
      }
      if (cliArgs.join(' ') === 'mcp get gitnexus --json') {
        return callback(
          null,
          JSON.stringify({
            ...pluginRegistration,
            transport: { type: 'stdio', command: '/usr/local/bin/gitnexus', args: ['mcp'] },
          }),
          '',
        );
      }
      return callback(new Error(`unexpected command: ${cliArgs.join(' ')}`), '', '');
    });

    const { runCodexDoctor } = await import('../../src/cli/doctor-codex.js');
    const report = await runCodexDoctor({ runProtocol: false });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Codex plugin/hooks', status: 'warn' }),
        expect.objectContaining({ name: 'Codex MCP registration', status: 'pass' }),
      ]),
    );
  });

  it('reports actionable failures when the Codex CLI is missing', async () => {
    execFileMock.mockImplementation((...args: any[]) => {
      const callback = args.at(-1);
      return callback(new Error('codex: command not found'), '', '');
    });

    const { runCodexDoctor } = await import('../../src/cli/doctor-codex.js');
    const report = await runCodexDoctor({ runProtocol: false });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Codex CLI', status: 'fail' }),
        expect.objectContaining({ name: 'Codex plugin/hooks', status: 'warn' }),
        expect.objectContaining({ name: 'Codex MCP registration', status: 'fail' }),
      ]),
    );
  });

  it('sets a non-zero CLI exit code when doctor finds an actionable failure', async () => {
    execFileMock.mockImplementation((...args: any[]) => {
      const callback = args.at(-1);
      return callback(new Error('codex: command not found'), '', '');
    });
    const previousExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const { doctorCodexCommand } = await import('../../src/cli/doctor-codex.js');
      const report = await doctorCodexCommand({ runProtocol: false });

      expect(report.ok).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
