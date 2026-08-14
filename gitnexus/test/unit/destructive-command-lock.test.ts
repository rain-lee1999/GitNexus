import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const {
  rmMock,
  findRepoMock,
  unregisterRepoMock,
  listRegisteredReposMock,
  readRegistryMock,
  resolveRegistryEntryMock,
  assertSafeStoragePathMock,
  withAnalysisLockMock,
} = vi.hoisted(() => ({
  rmMock: vi.fn(),
  findRepoMock: vi.fn(),
  unregisterRepoMock: vi.fn(),
  listRegisteredReposMock: vi.fn(),
  readRegistryMock: vi.fn(),
  resolveRegistryEntryMock: vi.fn(),
  assertSafeStoragePathMock: vi.fn(),
  withAnalysisLockMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { rm: rmMock },
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  findRepo: findRepoMock,
  unregisterRepo: unregisterRepoMock,
  listRegisteredRepos: listRegisteredReposMock,
  readRegistry: readRegistryMock,
  resolveRegistryEntry: resolveRegistryEntryMock,
  assertSafeStoragePath: assertSafeStoragePathMock,
  withAnalysisLock: withAnalysisLockMock,
  UnsafeStoragePathError: class UnsafeStoragePathError extends Error {},
  RegistryNotFoundError: class RegistryNotFoundError extends Error {},
  RegistryAmbiguousTargetError: class RegistryAmbiguousTargetError extends Error {},
}));

describe('destructive index commands use the worktree analysis lock', () => {
  const activeLockPaths = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    activeLockPaths.clear();
    process.exitCode = undefined;

    withAnalysisLockMock.mockImplementation(
      async (repoPath: string, callback: () => Promise<unknown>) => {
        activeLockPaths.add(repoPath);
        try {
          return await callback();
        } finally {
          activeLockPaths.delete(repoPath);
        }
      },
    );
    rmMock.mockImplementation(async (storagePath: string) => {
      expect(activeLockPaths).toContain(path.dirname(storagePath));
    });
    unregisterRepoMock.mockResolvedValue(undefined);
    assertSafeStoragePathMock.mockReturnValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('locks the current worktree for clean --force before deleting and unregistering', async () => {
    const repoPath = path.resolve('worktrees', 'current');
    const storagePath = path.join(repoPath, '.gitnexus');
    findRepoMock.mockResolvedValue({ repoPath, storagePath });
    const { cleanCommand } = await import('../../src/cli/clean.js');

    await cleanCommand({ force: true });

    expect(withAnalysisLockMock).toHaveBeenCalledWith(repoPath, expect.any(Function));
    expect(rmMock).toHaveBeenCalledWith(storagePath, { recursive: true, force: true });
    expect(unregisterRepoMock).toHaveBeenCalledWith(repoPath);
  });

  it('locks every registered worktree for clean --all --force', async () => {
    const entries = ['one', 'two'].map((name, index) => ({
      name: `repo-${index + 1}`,
      path: path.resolve('worktrees', name),
      storagePath: path.resolve('worktrees', name, '.gitnexus'),
    }));
    listRegisteredReposMock.mockResolvedValue(entries);
    const { cleanCommand } = await import('../../src/cli/clean.js');

    await cleanCommand({ all: true, force: true });

    expect(withAnalysisLockMock).toHaveBeenCalledTimes(entries.length);
    for (const entry of entries) {
      expect(withAnalysisLockMock).toHaveBeenCalledWith(entry.path, expect.any(Function));
      expect(unregisterRepoMock).toHaveBeenCalledWith(entry.path);
    }
  });

  it('locks the resolved target worktree for remove --force', async () => {
    const repoPath = path.resolve('worktrees', 'target');
    const entry = {
      name: 'target',
      path: repoPath,
      storagePath: path.join(repoPath, '.gitnexus'),
    };
    readRegistryMock.mockResolvedValue([entry]);
    resolveRegistryEntryMock.mockReturnValue(entry);
    const { removeCommand } = await import('../../src/cli/remove.js');

    await removeCommand('target', { force: true });

    expect(withAnalysisLockMock).toHaveBeenCalledWith(repoPath, expect.any(Function));
    expect(rmMock).toHaveBeenCalledWith(entry.storagePath, { recursive: true, force: true });
    expect(unregisterRepoMock).toHaveBeenCalledWith(repoPath);
  });
});
