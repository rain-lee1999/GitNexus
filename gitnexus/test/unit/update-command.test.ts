import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileSyncMock = vi.fn();
const spawnSyncMock = vi.fn(() => ({ status: 0, error: undefined }));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

describe('updateCommand', () => {
  let tempDir: string;
  let sourceRepo: string;
  let originalSourceRepo: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    originalSourceRepo = process.env.GITNEXUS_UPDATE_SOURCE_REPO;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-update-test-'));
    sourceRepo = path.join(tempDir, 'source');
    await fs.mkdir(path.join(sourceRepo, '.git'), { recursive: true });
    process.env.GITNEXUS_UPDATE_SOURCE_REPO = sourceRepo;

    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') {
        return '/target-repo\n';
      }
      if (command === 'git' && args[0] === 'status') return '';
      if (command === 'git' && args[0] === 'fetch') return '';
      if (command === 'git' && args[0] === 'rev-list') return '2\n';
      if (command === 'git' && args[0] === 'diff') return '';
      if (command === 'git' && args[0] === 'pull') return '';
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--short') return 'abc123\n';
      throw new Error(`unexpected execFileSync: ${command} ${args.join(' ')}`);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalSourceRepo === undefined) {
      delete process.env.GITNEXUS_UPDATE_SOURCE_REPO;
    } else {
      process.env.GITNEXUS_UPDATE_SOURCE_REPO = originalSourceRepo;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('checks for updates without building or installing', async () => {
    const { updateCommand } = await import('../../src/cli/update.js');

    await updateCommand({ check: true });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['fetch', '--quiet', sourceRepo, 'main'],
      expect.objectContaining({ cwd: '/target-repo' }),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('2 update commit(s) available'),
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('makes --simple explicitly tell the user to run gitnexus update when dependency manifests changed', async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel')
        return '/target-repo\n';
      if (command === 'git' && args[0] === 'status') return '';
      if (command === 'git' && args[0] === 'fetch') return '';
      if (command === 'git' && args[0] === 'rev-list') return '1\n';
      if (command === 'git' && args[0] === 'diff') return 'gitnexus/package-lock.json\n';
      if (command === 'git' && args[0] === 'pull') return '';
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--short') return 'def456\n';
      throw new Error(`unexpected execFileSync: ${command} ${args.join(' ')}`);
    });
    const { updateCommand } = await import('../../src/cli/update.js');

    await updateCommand({ simple: true });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Run: gitnexus update'));
    expect(spawnSyncMock).not.toHaveBeenCalledWith('node', ['scripts/build.js'], expect.anything());
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '.'],
      expect.anything(),
    );
  });

  it('makes --simple explicitly tell the user to run gitnexus update --setup when setup-sensitive files changed', async () => {
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel')
        return '/target-repo\n';
      if (command === 'git' && args[0] === 'status') return '';
      if (command === 'git' && args[0] === 'fetch') return '';
      if (command === 'git' && args[0] === 'rev-list') return '1\n';
      if (command === 'git' && args[0] === 'diff') return 'gitnexus/src/cli/setup.ts\n';
      if (command === 'git' && args[0] === 'pull') return '';
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--short') return 'fedcba\n';
      throw new Error(`unexpected execFileSync: ${command} ${args.join(' ')}`);
    });
    const { updateCommand } = await import('../../src/cli/update.js');

    await updateCommand({ simple: true });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'node',
      ['scripts/build.js'],
      expect.objectContaining({ cwd: expect.stringContaining('/gitnexus') }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '.'],
      expect.objectContaining({ cwd: expect.stringContaining('/gitnexus') }),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Run: gitnexus update --setup'),
    );
  });

  it('runs setup only when --setup is requested on a full update', async () => {
    const { updateCommand } = await import('../../src/cli/update.js');

    await updateCommand({ setup: true });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npm',
      ['install'],
      expect.objectContaining({ cwd: expect.stringContaining('/gitnexus') }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'node',
      ['scripts/build.js'],
      expect.objectContaining({ cwd: expect.stringContaining('/gitnexus') }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '.'],
      expect.objectContaining({ cwd: expect.stringContaining('/gitnexus') }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'node',
      [expect.stringContaining('dist/cli/index.js'), 'setup'],
      expect.objectContaining({ cwd: expect.stringContaining('/gitnexus') }),
    );
  });
});
