import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageSpecifier = `gitnexus@${(require('../../package.json') as { version: string }).version}`;

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }
});

const execFileSyncMock = vi.fn((cmd: string, args: string[]) => {
  const commandName = args[0];
  if (cmd === 'which' && commandName === 'hermes') return '/usr/local/bin/hermes\n';
  if (cmd === 'which' && commandName === 'gitnexus') return '/usr/local/bin/gitnexus\n';
  throw new Error('not found');
});

const spawnMock = vi.fn(() => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  process.nextTick(() => child.emit('close', 0, null));
  return child;
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}));

describe('setupCommand Hermes support', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalCodexHome: string | undefined;
  let platformDescriptor: PropertyDescriptor | undefined;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value,
      configurable: true,
    });
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalCodexHome = process.env.CODEX_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-hermes-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.CODEX_HOME;

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    setPlatform('darwin');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }

    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('invokes hermes mcp add with the resolved global gitnexus binary', async () => {
    await fs.mkdir(path.join(tempHome, '.hermes'), { recursive: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/hermes',
      ['mcp', 'add', 'gitnexus', '--command', '/usr/local/bin/gitnexus', '--args', 'mcp'],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    expect(spawnMock.mock.results[0].value.stdin.end).toHaveBeenCalledWith('Y\n');
  });

  it('invokes hermes mcp add with npx fallback when gitnexus is not on PATH', async () => {
    await fs.mkdir(path.join(tempHome, '.hermes'), { recursive: true });
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      const commandName = args[0];
      if (cmd === 'which' && commandName === 'hermes') return '/usr/local/bin/hermes\n';
      if (cmd === 'which' && commandName === 'gitnexus') throw new Error('not found');
      throw new Error('not found');
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/hermes',
      ['mcp', 'add', 'gitnexus', '--command', 'npx', '--args', '-y', packageSpecifier, 'mcp'],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    expect(spawnMock.mock.results[0].value.stdin.end).toHaveBeenCalledWith('Y\n');
  });

  it('skips Hermes when neither ~/.hermes nor hermes command exists', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    expect(spawnMock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(tempHome, '.hermes'))).rejects.toThrow();
  });

  it('installs GitNexus skills into the Hermes software-development skill category', async () => {
    await fs.mkdir(path.join(tempHome, '.hermes'), { recursive: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const skillContent = await fs.readFile(
      path.join(tempHome, '.hermes', 'skills', 'software-development', 'gitnexus-cli', 'SKILL.md'),
      'utf-8',
    );
    expect(skillContent).toContain('GitNexus CLI Commands');
  });

  it('preserves existing Hermes skill files instead of overwriting local edits', async () => {
    const skillPath = path.join(
      tempHome,
      '.hermes',
      'skills',
      'software-development',
      'gitnexus-cli',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, '# Local Hermes GitNexus notes\n\nDo not overwrite me.', 'utf-8');
    await fs.mkdir(path.join(tempHome, '.hermes'), { recursive: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const skillContent = await fs.readFile(skillPath, 'utf-8');
    expect(skillContent).toBe('# Local Hermes GitNexus notes\n\nDo not overwrite me.');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('preserved existing'));
  });

  it('does not create configs for undetected editors while still configuring Codex', async () => {
    await fs.mkdir(path.join(tempHome, '.hermes'), { recursive: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
    await expect(fs.access(path.join(tempHome, '.cursor'))).rejects.toThrow();
    await expect(fs.access(path.join(tempHome, '.codex', 'config.toml'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.config', 'opencode'))).rejects.toThrow();
  });
});
