import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTempDir } from '../helpers/test-db.js';

const runFullAnalysisMock = vi.fn();

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

const originalHome = process.env.GITNEXUS_HOME;
const originalCli = process.env.GITNEXUS_CLI;
const originalSerenaHome = process.env.SERENA_HOME;
const originalSerenaArgsFile = process.env.GITNEXUS_SERENA_ARGS_FILE;
const handles: Array<{ cleanup: () => Promise<void> }> = [];

const createRepo = async () => {
  const repo = await createTempDir('gitnexus-refresh-repo-');
  handles.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo.dbPath });
  execFileSync('git', ['config', 'user.name', 'Refresh Test'], { cwd: repo.dbPath });
  execFileSync('git', ['config', 'user.email', 'refresh@example.test'], { cwd: repo.dbPath });
  await fs.writeFile(path.join(repo.dbPath, 'index.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'index.ts'], { cwd: repo.dbPath });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo.dbPath });
  return repo;
};

beforeEach(() => {
  runFullAnalysisMock.mockReset();
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = originalHome;
  if (originalCli === undefined) delete process.env.GITNEXUS_CLI;
  else process.env.GITNEXUS_CLI = originalCli;
  if (originalSerenaHome === undefined) delete process.env.SERENA_HOME;
  else process.env.SERENA_HOME = originalSerenaHome;
  if (originalSerenaArgsFile === undefined) delete process.env.GITNEXUS_SERENA_ARGS_FILE;
  else process.env.GITNEXUS_SERENA_ARGS_FILE = originalSerenaArgsFile;
  await Promise.all(handles.splice(0).map((handle) => handle.cleanup()));
});

describe('worktree refresh coordinator', () => {
  it('requires an absolute worktree root and derives collision-resistant aliases', async () => {
    const repo = await createRepo();
    const { deriveWorktreeAlias, resolveWorktreePath } = await import('../../src/cli/refresh.js');

    await expect(resolveWorktreePath('.')).rejects.toThrow('`--path` must be an absolute');
    await expect(resolveWorktreePath(path.join(repo.dbPath, 'nested'))).rejects.toThrow(
      'Worktree path does not exist',
    );
    await expect(resolveWorktreePath(repo.dbPath)).resolves.toBe(await fs.realpath(repo.dbPath));

    expect(deriveWorktreeAlias('/tmp/one/app')).not.toBe(deriveWorktreeAlias('/tmp/two/app'));
    expect(deriveWorktreeAlias('/tmp/one/app')).toMatch(/^app-[a-f0-9]{12}$/);
  });

  it('recognizes a global CLI symlink as the compiled refresh entrypoint', async () => {
    const { isCompiledRefreshEntrypoint } = await import('../../src/cli/refresh.js');

    expect(
      isCompiledRefreshEntrypoint(
        '/usr/local/bin/gitnexus',
        () => '/opt/lib/node_modules/gitnexus/dist/cli/index.js',
      ),
    ).toBe(true);
    expect(
      isCompiledRefreshEntrypoint('/usr/local/bin/gitnexus', () => '/opt/lib/other-cli.js'),
    ).toBe(false);
  });

  it('persists state and stale markers independently from generated agent assets', async () => {
    const repo = await createRepo();
    const home = await createTempDir('gitnexus-refresh-home-');
    handles.push(home);
    process.env.GITNEXUS_HOME = home.dbPath;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { getRefreshStatus, refreshCommand } = await import('../../src/cli/refresh.js');

    await refreshCommand('init', { path: repo.dbPath, alias: 'repo-worktree' });
    expect((await getRefreshStatus(await fs.realpath(repo.dbPath))).alias).toBe('repo-worktree');

    await refreshCommand('mark', { path: repo.dbPath, reason: 'test-change' });
    const stale = await getRefreshStatus(await fs.realpath(repo.dbPath));
    expect(stale.refreshRequired).toBe(true);
    expect(stale.reason).toBe('missing-index');
    expect(stale.staleMarkerCount).toBe(1);
    await expect(fs.access(path.join(repo.dbPath, 'AGENTS.md'))).rejects.toThrow();
    await expect(fs.access(path.join(repo.dbPath, '.agents', 'skills'))).rejects.toThrow();
    expect(log).toHaveBeenCalled();
  });

  it('does not create GitNexus state when a global hook marks an uninitialized repository', async () => {
    const repo = await createRepo();
    const home = await createTempDir('gitnexus-refresh-uninitialized-home-');
    handles.push(home);
    process.env.GITNEXUS_HOME = home.dbPath;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { refreshCommand } = await import('../../src/cli/refresh.js');

    await refreshCommand('mark', { path: repo.dbPath, reason: 'global-hook' });

    await expect(fs.access(path.join(repo.dbPath, '.gitnexus'))).rejects.toThrow();
  });

  it('uses index-only analysis and clears only the stale markers it observed', async () => {
    const repo = await createRepo();
    const home = await createTempDir('gitnexus-refresh-ensure-home-');
    handles.push(home);
    process.env.GITNEXUS_HOME = home.dbPath;
    const { getRefreshStatus, refreshCommand } = await import('../../src/cli/refresh.js');
    const root = await fs.realpath(repo.dbPath);
    runFullAnalysisMock.mockResolvedValue({ repoName: 'repo-worktree', repoPath: root, stats: {} });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await refreshCommand('init', { path: root, alias: 'repo-worktree' });
    await refreshCommand('mark', { path: root, reason: 'before-ensure' });
    await refreshCommand('ensure', { path: root });

    expect(runFullAnalysisMock).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        force: true,
        indexOnly: true,
        skipWorkers: true,
        registryName: 'repo-worktree',
      }),
      expect.any(Object),
    );
    expect((await getRefreshStatus(root)).staleMarkerCount).toBe(0);
  });

  it('forwards refresh --force without enabling managed assets', async () => {
    const repo = await createRepo();
    const home = await createTempDir('gitnexus-refresh-force-home-');
    handles.push(home);
    process.env.GITNEXUS_HOME = home.dbPath;
    const { refreshCommand } = await import('../../src/cli/refresh.js');
    const root = await fs.realpath(repo.dbPath);
    runFullAnalysisMock.mockResolvedValue({ repoName: 'repo', repoPath: root, stats: {} });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await refreshCommand('ensure', { path: root, force: true });

    expect(runFullAnalysisMock).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ force: true, indexOnly: true, skipWorkers: true }),
      expect.any(Object),
    );
  });

  it('requires explicit Serena languages only alongside --with-serena', async () => {
    const repo = await createRepo();
    const home = await createTempDir('gitnexus-refresh-serena-validation-home-');
    handles.push(home);
    process.env.GITNEXUS_HOME = home.dbPath;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { refreshCommand } = await import('../../src/cli/refresh.js');
    const root = await fs.realpath(repo.dbPath);

    await refreshCommand('init', { path: root, withSerena: true });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      'GitNexus refresh failed: `--with-serena` requires at least one `--serena-language <language>`.',
    );

    process.exitCode = undefined;
    await refreshCommand('init', { path: root, serenaLanguages: ['typescript'] });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      'GitNexus refresh failed: `--serena-language` requires `--with-serena`.',
    );
  });

  it('prewarms Serena non-interactively with every explicit language', async () => {
    const repo = await createRepo();
    const home = await createTempDir('gitnexus-refresh-serena-home-');
    const serenaHome = await createTempDir('gitnexus-refresh-serena-state-');
    handles.push(home, serenaHome);
    const fakeSerena = path.join(repo.dbPath, 'fake-serena');
    const argsPath = path.join(repo.dbPath, 'serena-args.txt');
    await fs.writeFile(
      fakeSerena,
      '#!/usr/bin/env sh\nprintf \'%s\\n\' "$@" > "$GITNEXUS_SERENA_ARGS_FILE"\n',
      { mode: 0o755 },
    );
    await fs.chmod(fakeSerena, 0o755);
    process.env.GITNEXUS_HOME = home.dbPath;
    process.env.SERENA_HOME = serenaHome.dbPath;
    process.env.GITNEXUS_SERENA_ARGS_FILE = argsPath;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { refreshCommand } = await import('../../src/cli/refresh.js');
    const root = await fs.realpath(repo.dbPath);

    await refreshCommand('init', {
      path: root,
      withSerena: true,
      serenaBin: fakeSerena,
      serenaLanguages: ['typescript', 'python'],
    });

    await expect(fs.readFile(argsPath, 'utf8')).resolves.toBe(
      ['project', 'index', root, '--language', 'typescript', '--language', 'python', ''].join('\n'),
    );
    const state = JSON.parse(
      await fs.readFile(path.join(root, '.gitnexus', 'refresh', 'state.json'), 'utf8'),
    ) as { serenaInitializedAt?: string };
    expect(state.serenaInitializedAt).toEqual(expect.any(String));
  });

  it('installs conventional Git hooks but never overwrites custom, modified, or Husky dispatchers', async () => {
    const repo = await createRepo();
    const fakeCli = path.join(repo.dbPath, 'gitnexus-cli');
    await fs.writeFile(fakeCli, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    process.env.GITNEXUS_CLI = fakeCli;
    const { installGitHooks } = await import('../../src/cli/refresh.js');

    const normal = await installGitHooks(repo.dbPath);
    expect(normal.installed).toHaveLength(4);
    await expect(fs.readFile(normal.installed[0], 'utf8')).resolves.toContain(
      '# gitnexus-refresh-hook: managed v1',
    );

    const managedButModified = normal.installed[0];
    await fs.appendFile(managedButModified, '# user addition\n');
    const changedManaged = await installGitHooks(repo.dbPath);
    expect(changedManaged.installed).toEqual([]);
    expect(changedManaged.skipped).toContain('does not exactly match');
    await expect(fs.readFile(managedButModified, 'utf8')).resolves.toContain('# user addition');

    execFileSync('git', ['config', 'core.hooksPath', 'custom-hooks'], { cwd: repo.dbPath });
    const custom = await installGitHooks(repo.dbPath);
    expect(custom.installed).toEqual([]);
    expect(custom.skipped).toContain('will not overwrite an unknown hook dispatcher');

    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: repo.dbPath });
    const userHook = path.join(repo.dbPath, '.husky', 'post-commit');
    await fs.mkdir(path.dirname(userHook), { recursive: true });
    await fs.writeFile(userHook, '#!/usr/bin/env sh\necho user\n');
    const husky = await installGitHooks(repo.dbPath);
    expect(husky.installed).toEqual([]);
    expect(husky.skipped).toContain('will not write tracked .husky/post-* files');
    await expect(fs.readFile(userHook, 'utf8')).resolves.toContain('echo user');
  });

  it('recognizes linked worktrees without misclassifying a separate Git directory', async () => {
    const repo = await createRepo();
    const fakeCli = path.join(repo.dbPath, 'gitnexus-cli');
    await fs.writeFile(fakeCli, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    process.env.GITNEXUS_CLI = fakeCli;
    const { installGitHooks } = await import('../../src/cli/refresh.js');

    const separateGitDir = path.join(repo.dbPath, 'separate-admin');
    const separateRepo = path.join(repo.dbPath, 'separate-worktree');
    await fs.mkdir(separateRepo);
    execFileSync('git', ['init', '-q', `--separate-git-dir=${separateGitDir}`], {
      cwd: separateRepo,
    });
    const standalone = await installGitHooks(separateRepo);
    expect(standalone.skipped).toBeUndefined();
    expect(standalone.installed).toHaveLength(4);

    const linked = path.join(repo.dbPath, 'linked-worktree');
    execFileSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: repo.dbPath });
    const linkedResult = await installGitHooks(linked);
    expect(linkedResult.installed).toEqual([]);
    expect(linkedResult.skipped).toContain('linked worktree');
  });
});
