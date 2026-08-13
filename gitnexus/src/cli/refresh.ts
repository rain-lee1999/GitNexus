/**
 * Worktree-safe graph refresh coordinator.
 *
 * `analyze` is intentionally a full repository operation: it owns a graph
 * database, touches the global registry, and may generate agent assets. This
 * command is the narrow automation boundary used by Codex/Git hooks. It
 * records staleness cheaply, runs at most one index-only writer per worktree,
 * and never needs to guess the caller's current checkout.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import {
  ensureGitNexusIgnored,
  getAnalysisLockPath,
  getGlobalDir,
  getGlobalRegistryLockPath,
  getGlobalRegistryPath,
  getIndexHealth,
  getStoragePaths,
  loadMeta,
  registerRepo,
  withFileLock,
} from '../storage/repo-manager.js';
import { getCurrentCommit, getGitRoot } from '../storage/git.js';
import { runFullAnalysis } from '../core/run-analyze.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

const STATE_FILE = 'state.json';
const STATE_LOCK_FILE = 'state.lock';
const STALE_DIR = 'stale';
const SERENA_LOCK_FILE = 'gitnexus-refresh.lock';
const REQUEST_DEBOUNCE_MS = 15_000;
// A detached ensure can wait for the writer lock and then run a large index.
// Treat its recorded PID as active until it exits (or this conservative lease
// expires), rather than repeatedly queueing another ensure every debounce.
const REQUEST_LEASE_MS = 45 * 60 * 1000;
const ANALYSIS_HEAP_MB = 8192;

type RefreshAction = 'init' | 'mark' | 'status' | 'plan' | 'ensure' | 'request';
type RequestState = 'queued' | 'already-queued' | 'unavailable';

export interface RefreshOptions {
  path?: string;
  alias?: string;
  reason?: string;
  json?: boolean;
  installGitHooks?: boolean;
  force?: boolean;
  withSerena?: boolean;
  serenaBin?: string;
  /** Commander maps repeated `--serena-language` flags to this singular key. */
  serenaLanguage?: string[];
  /** Programmatic callers may use the plural spelling. */
  serenaLanguages?: string[];
}

export interface RefreshState {
  version: 1;
  worktreePath: string;
  alias: string;
  initializedAt: string;
  lastEnsureAt?: string;
  lastEnsureCommit?: string;
  lastRequestAt?: string;
  requestPid?: number;
  requestExpiresAt?: string;
  serenaInitializedAt?: string;
}

export interface RefreshStatus {
  worktreePath: string;
  alias: string;
  initialized: boolean;
  refreshRequired: boolean;
  reason: string;
  staleMarkerCount: number;
  indexedCommit?: string;
  currentCommit?: string;
  health?: string;
  queued?: boolean;
  requestState?: RequestState;
}

/**
 * A read-only declaration of paths an `init` / `ensure` may mutate. This is
 * deliberately separate from status: a client can request authority for the
 * GitNexus-owned filesystem surface before coordinator state exists.
 */
export interface RefreshWriteTarget {
  path: string;
  purpose: string;
  willWrite: boolean;
}

export interface RefreshPlan {
  worktreePath: string;
  requiresWriteAccess: true;
  /** Whether this plan includes the optional Serena prewarm write targets. */
  coversOptionalSerena: boolean;
  /**
   * `writeTargets` is complete for GitNexus-owned work. It is deliberately
   * false when `--with-serena` starts an external executable: language-server
   * providers and toolchains can use additional environment-specific
   * cache/install paths that GitNexus cannot enumerate safely in advance.
   */
  writeTargetsComplete: boolean;
  /** Explicit disclosure for externally spawned Serena/LSP processes. */
  externalWriteRisk?: string;
  writeTargets: RefreshWriteTarget[];
}

interface RefreshPaths {
  storagePath: string;
  refreshPath: string;
  statePath: string;
  stateLockPath: string;
  stalePath: string;
}

interface HookInstallResult {
  installed: string[];
  skipped?: string;
}

const print = (value: unknown, options?: RefreshOptions): void => {
  if (options?.json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
};

/**
 * `refresh ensure` runs the same ingestion pipeline as `analyze`, so preserve
 * the CLI's large-heap guarantee. Unit callers and embedded consumers do not
 * get re-execed: only the actual compiled CLI entrypoint is eligible.
 */
export const isCompiledRefreshEntrypoint = (
  entrypoint = process.argv[1],
  resolveRealpath: (candidate: string) => string = realpathSync.native,
): boolean => {
  if (!entrypoint) return false;
  // Global npm installs commonly expose `gitnexus` as a symlink to the
  // compiled index.js. Check its real path so routine PATH invocation gets
  // the same heap guarantee as `node dist/cli/index.js`; unit runners remain
  // excluded because their real entrypoint is not this CLI module.
  let resolvedEntrypoint = entrypoint;
  try {
    resolvedEntrypoint = resolveRealpath(entrypoint);
  } catch {
    // A deleted/non-filesystem argv entry is not a deployable CLI target.
  }
  return path.basename(resolvedEntrypoint) === 'index.js';
};

const ensureAnalysisHeap = (): boolean => {
  if (!isCompiledRefreshEntrypoint()) return false;
  const limit = v8.getHeapStatistics().heap_size_limit;
  if (limit >= ANALYSIS_HEAP_MB * 1024 * 1024 * 0.9) return false;
  try {
    execFileSync(
      process.execPath,
      [`--max-old-space-size=${ANALYSIS_HEAP_MB}`, ...process.argv.slice(1)],
      {
        stdio: 'inherit',
        env: { ...process.env, GITNEXUS_REFRESH_HEAP_READY: '1' },
      },
    );
  } catch (error: any) {
    process.exitCode = error?.status ?? 1;
  }
  return true;
};

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

const getRefreshPaths = (worktreePath: string): RefreshPaths => {
  const { storagePath } = getStoragePaths(worktreePath);
  const refreshPath = path.join(storagePath, 'refresh');
  return {
    storagePath,
    refreshPath,
    statePath: path.join(refreshPath, STATE_FILE),
    stateLockPath: path.join(refreshPath, STATE_LOCK_FILE),
    stalePath: path.join(refreshPath, STALE_DIR),
  };
};

/**
 * A refresh plan is an authority contract across a foreground CLI, hooks, and
 * detached workers. A relative home would be resolved against each process's
 * cwd and could therefore turn one approved plan into several physical
 * registries/locks. Other legacy commands retain their historic behaviour;
 * the coordinator rejects that ambiguity at its boundary.
 */
const validateRefreshHome = (): void => {
  const configuredHome = process.env.GITNEXUS_HOME;
  if (configuredHome && !path.isAbsolute(configuredHome)) {
    throw new Error('GITNEXUS_HOME must be an absolute path when using `gitnexus refresh`.');
  }
};

/**
 * Linked worktrees have a `.git` file and `ensureGitNexusIgnored` deliberately
 * leaves the common checkout's `info/exclude` alone. Keep a non-mutating
 * entry in the plan so callers see that Git metadata was considered, but do
 * not pretend the path below is a real writable target for linked worktrees.
 */
const getGitExcludeTarget = (worktreePath: string): RefreshWriteTarget => {
  const dotGitPath = path.join(worktreePath, '.git');
  try {
    const dotGitStat = statSync(dotGitPath);
    if (!dotGitStat.isDirectory()) {
      return {
        path: dotGitPath,
        purpose: 'Git exclude metadata for .gitnexus (linked worktree: skipped)',
        willWrite: false,
      };
    }
  } catch {
    return {
      path: dotGitPath,
      purpose: 'Git metadata unavailable; no exclude entry will be written',
      willWrite: false,
    };
  }
  return {
    path: path.join(dotGitPath, 'info', 'exclude'),
    purpose: 'Git exclude metadata for .gitnexus',
    willWrite: true,
  };
};

const getSerenaLanguages = (options: RefreshOptions): string[] =>
  (options.serenaLanguage ?? options.serenaLanguages ?? []).map((language) => language.trim());

const validateSerenaOptions = (options: RefreshOptions): void => {
  const serenaLanguages = getSerenaLanguages(options);
  if (!options.withSerena && serenaLanguages.length > 0) {
    throw new Error('`--serena-language` requires `--with-serena`.');
  }
  if (!options.withSerena) return;
  if (serenaLanguages.length === 0 || serenaLanguages.some((language) => language.length === 0)) {
    throw new Error('`--with-serena` requires at least one `--serena-language <language>`.');
  }
  const serenaBin = options.serenaBin ?? process.env.GITNEXUS_SERENA_BIN;
  if (!serenaBin || !path.isAbsolute(serenaBin)) {
    throw new Error(
      '`--with-serena` requires an absolute `--serena-bin` path (or GITNEXUS_SERENA_BIN).',
    );
  }
};

const getSerenaHome = (): string => {
  const configuredSerenaHome = process.env.SERENA_HOME || path.join(os.homedir(), '.serena');
  if (!path.isAbsolute(configuredSerenaHome)) {
    throw new Error('SERENA_HOME must be an absolute path when `--with-serena` is used.');
  }
  try {
    return realpathSync.native(configuredSerenaHome);
  } catch {
    // Initial setup legitimately creates this directory. Resolve it now so
    // every worktree uses the same lock key rather than a cwd-relative one.
    return path.resolve(configuredSerenaHome);
  }
};

const isDirectory = (candidate: string): boolean => {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const resolveSerenaDataFolder = (worktreePath: string, configuredLocation: string): string => {
  const replacements: Record<string, string> = {
    projectDir: worktreePath,
    projectFolderName: path.basename(worktreePath),
  };
  const substituted = configuredLocation.replace(/\$([A-Za-z_]\w*)/g, (placeholder, name) => {
    const replacement = replacements[name];
    if (replacement === undefined) {
      throw new Error(
        `Could not resolve Serena project data target: unsupported placeholder ${placeholder}.`,
      );
    }
    return replacement;
  });
  const configuredPath = path.resolve(worktreePath, substituted);
  const defaultPath = path.join(worktreePath, '.serena');

  // Match Serena's documented fallback: prefer an existing configured path,
  // then an existing in-project `.serena`, otherwise use the configured path
  // that `serena project index` will create.
  if (isDirectory(configuredPath)) return configuredPath;
  if (!samePath(configuredPath, defaultPath) && isDirectory(defaultPath)) return defaultPath;
  return configuredPath;
};

const getSerenaPlanTargets = (
  worktreePath: string,
  options: RefreshOptions,
): RefreshWriteTarget[] => {
  if (!options.withSerena) return [];

  const serenaHome = getSerenaHome();
  const configPath = path.join(serenaHome, 'serena_config.yml');
  let configuredLocation = '$projectDir/.serena';
  if (existsSync(configPath)) {
    try {
      const parsed = yaml.load(readFileSync(configPath, 'utf8'), {
        schema: yaml.JSON_SCHEMA,
      }) as Record<string, unknown> | undefined;
      if (parsed && Object.hasOwn(parsed, 'project_serena_folder_location')) {
        if (typeof parsed.project_serena_folder_location !== 'string') {
          throw new Error('`project_serena_folder_location` must be a string.');
        }
        configuredLocation = parsed.project_serena_folder_location;
      }
    } catch (error: any) {
      throw new Error(
        `Could not read Serena configuration ${configPath}: ${error?.message ?? String(error)}`,
      );
    }
  }
  const projectDataPath = resolveSerenaDataFolder(worktreePath, configuredLocation);

  return [
    {
      path: serenaHome,
      purpose: 'Serena global home used for configuration and cross-worktree coordination',
      willWrite: true,
    },
    {
      path: configPath,
      purpose: 'Serena global configuration and registered-project list',
      willWrite: true,
    },
    {
      path: path.join(serenaHome, SERENA_LOCK_FILE),
      purpose: 'GitNexus cross-worktree Serena indexing lock',
      willWrite: true,
    },
    {
      path: projectDataPath,
      purpose: 'Resolved Serena project data: project.yml, symbol caches, and indexing logs',
      willWrite: true,
    },
    ...(samePath(projectDataPath, path.join(worktreePath, '.serena'))
      ? []
      : [
          {
            path: path.join(worktreePath, '.serena', 'logs', 'indexing.txt'),
            purpose: 'Serena indexing failure log (only if indexing reports failed files)',
            willWrite: true,
          },
        ]),
  ];
};

export const getRefreshPlan = (worktreePath: string, options: RefreshOptions = {}): RefreshPlan => {
  validateRefreshHome();
  validateSerenaOptions(options);
  const paths = getRefreshPaths(worktreePath);
  const globalDir = getGlobalDir();
  return {
    worktreePath,
    requiresWriteAccess: true,
    coversOptionalSerena: Boolean(options.withSerena),
    writeTargetsComplete: !options.withSerena,
    ...(options.withSerena
      ? {
          externalWriteRisk:
            'Serena project indexing starts an external executable and language servers. ' +
            'The listed Serena paths are GitNexus-known targets, not an exhaustive list: ' +
            'language-server or toolchain caches/install paths may also be written. ' +
            'Require separate authority for those external writes before using --with-serena.',
        }
      : {}),
    writeTargets: [
      {
        path: paths.storagePath,
        purpose: 'Per-worktree graph index, metadata, and refresh state',
        willWrite: true,
      },
      getGitExcludeTarget(worktreePath),
      {
        path: getAnalysisLockPath(worktreePath),
        purpose: 'Per-worktree cross-process analysis lock',
        willWrite: true,
      },
      {
        path: getGlobalRegistryPath(),
        purpose: 'Global repository registry',
        willWrite: true,
      },
      {
        path: getGlobalRegistryLockPath(),
        purpose: 'Global registry transaction lock',
        willWrite: true,
      },
      {
        path: globalDir,
        purpose: 'Global GitNexus home containing the registry and refresh locks',
        willWrite: true,
      },
      ...(options.installGitHooks ? getGitHookInstallPlanTargets(worktreePath) : []),
      ...getSerenaPlanTargets(worktreePath, options),
    ],
  };
};

/**
 * Deliberately reject relative paths and subdirectories. stdio MCP cannot
 * see its client's cwd, so a coordinator must be told an unambiguous actual
 * worktree root rather than silently resolving against its own process cwd.
 */
export const resolveWorktreePath = async (inputPath: string | undefined): Promise<string> => {
  if (!inputPath || !path.isAbsolute(inputPath)) {
    throw new Error('`--path` must be an absolute Git worktree root.');
  }

  let resolvedInput: string;
  try {
    resolvedInput = await fs.realpath(inputPath);
  } catch {
    throw new Error(`Worktree path does not exist: ${inputPath}`);
  }

  const gitRoot = getGitRoot(resolvedInput);
  if (!gitRoot) throw new Error(`Not a Git worktree: ${resolvedInput}`);

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(gitRoot);
  } catch {
    canonicalRoot = path.resolve(gitRoot);
  }
  if (!samePath(resolvedInput, canonicalRoot)) {
    throw new Error(
      `\`--path\` must name the worktree root, not a child directory. Use: ${canonicalRoot}`,
    );
  }
  return canonicalRoot;
};

const normalizeAlias = (alias: string): string => {
  const normalized = alias.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(normalized)) {
    throw new Error(
      '`--alias` must be 1–96 characters containing only letters, digits, `.`, `_`, or `-`.',
    );
  }
  return normalized;
};

export const deriveWorktreeAlias = (worktreePath: string): string => {
  const base =
    path
      .basename(worktreePath)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72) || 'worktree';
  const digest = createHash('sha256').update(worktreePath).digest('hex').slice(0, 12);
  return `${base}-${digest}`;
};

const readState = async (
  paths: RefreshPaths,
  worktreePath: string,
): Promise<RefreshState | null> => {
  try {
    const raw = await fs.readFile(paths.statePath, 'utf8');
    const state = JSON.parse(raw) as Partial<RefreshState>;
    if (
      state.version !== 1 ||
      typeof state.worktreePath !== 'string' ||
      typeof state.alias !== 'string' ||
      typeof state.initializedAt !== 'string' ||
      !samePath(state.worktreePath, worktreePath)
    ) {
      return null;
    }
    return state as RefreshState;
  } catch {
    return null;
  }
};

const writeJsonAtomically = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
};

const withStateLock = async <T>(worktreePath: string, callback: () => Promise<T>): Promise<T> => {
  const paths = getRefreshPaths(worktreePath);
  return withFileLock(paths.stateLockPath, callback);
};

const ensureState = async (
  worktreePath: string,
  requestedAlias?: string,
): Promise<RefreshState> => {
  const paths = getRefreshPaths(worktreePath);
  const existing = await readState(paths, worktreePath);
  const alias = requestedAlias
    ? normalizeAlias(requestedAlias)
    : (existing?.alias ?? deriveWorktreeAlias(worktreePath));
  const state: RefreshState = {
    version: 1,
    worktreePath,
    alias,
    initializedAt: existing?.initializedAt ?? new Date().toISOString(),
    lastEnsureAt: existing?.lastEnsureAt,
    lastEnsureCommit: existing?.lastEnsureCommit,
    lastRequestAt: existing?.lastRequestAt,
    requestPid: existing?.requestPid,
    requestExpiresAt: existing?.requestExpiresAt,
    serenaInitializedAt: existing?.serenaInitializedAt,
  };
  await writeJsonAtomically(paths.statePath, state);
  await ensureGitNexusIgnored(worktreePath);
  return state;
};

const readStaleMarkerNames = async (paths: RefreshPaths): Promise<string[]> => {
  try {
    const entries = await fs.readdir(paths.stalePath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

const writeStaleMarker = async (worktreePath: string, reason: string): Promise<void> => {
  const paths = getRefreshPaths(worktreePath);
  await fs.mkdir(paths.stalePath, { recursive: true });
  const safeReason = reason.trim().slice(0, 160) || 'unspecified';
  const markerPath = path.join(paths.stalePath, `${Date.now()}-${randomUUID()}.json`);
  await writeJsonAtomically(markerPath, {
    reason: safeReason,
    markedAt: new Date().toISOString(),
    commit: getCurrentCommit(worktreePath) || undefined,
  });
};

const clearStaleMarkers = async (paths: RefreshPaths, names: string[]): Promise<void> => {
  await Promise.all(
    names.map((name) => fs.rm(path.join(paths.stalePath, name), { force: true }).catch(() => {})),
  );
};

export const getRefreshStatus = async (worktreePath: string): Promise<RefreshStatus> => {
  const paths = getRefreshPaths(worktreePath);
  const [state, meta, health, markers] = await Promise.all([
    readState(paths, worktreePath),
    loadMeta(paths.storagePath),
    getIndexHealth(worktreePath),
    readStaleMarkerNames(paths),
  ]);
  const currentCommit = getCurrentCommit(worktreePath) || undefined;
  const indexedCommit = meta?.lastCommit || undefined;

  let reason = 'up-to-date';
  if (!state) reason = 'uninitialized';
  else if (!meta) reason = 'missing-index';
  else if (!health.ok) reason = health.reason;
  else if (!currentCommit || indexedCommit !== currentCommit) reason = 'head-mismatch';
  else if (markers.length > 0) reason = 'stale-marker';

  return {
    worktreePath,
    alias: state?.alias ?? deriveWorktreeAlias(worktreePath),
    initialized: Boolean(state),
    refreshRequired: reason !== 'up-to-date',
    reason,
    staleMarkerCount: markers.length,
    indexedCommit,
    currentCommit,
    health: health.reason,
  };
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;

const resolveCliInvocation = (): { command: string; args: string[] } | null => {
  const configured = process.env.GITNEXUS_CLI;
  if (configured && path.isAbsolute(configured) && existsSync(configured)) {
    return { command: configured, args: [] };
  }
  const builtEntry = fileURLToPath(new URL('./index.js', import.meta.url));
  if (existsSync(builtEntry)) return { command: process.execPath, args: [builtEntry] };
  const invokedEntry = process.argv[1];
  if (invokedEntry && path.isAbsolute(invokedEntry) && existsSync(invokedEntry)) {
    return { command: process.execPath, args: [invokedEntry] };
  }
  return null;
};

const hookScript = (event: string, cli: { command: string; args: string[] }): string => {
  const nodeOrCli = [cli.command, ...cli.args].map(shellQuote).join(' ');
  const checkoutGuard = event === 'post-checkout' ? '[ "$3" = "0" ] && exit 0\n' : '';
  return `#!/usr/bin/env sh
# gitnexus-refresh-hook: managed v1
# This hook is intentionally fail-open and only records graph staleness.
set +e
${checkoutGuard}root="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$root" ] || exit 0
${nodeOrCli} refresh mark --path "$root" --reason ${shellQuote(`git-${event}`)} >/dev/null 2>&1
exit 0
`;
};

const getConfiguredHooksPath = (worktreePath: string): string | undefined => {
  try {
    const result = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
};

const getGitHooksDirectory = (worktreePath: string): string => {
  const raw = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!raw) throw new Error('Git did not provide a hooks directory.');
  return path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw);
};

const GIT_HOOK_EVENTS = ['post-commit', 'post-merge', 'post-rewrite', 'post-checkout'] as const;

const isLinkedWorktree = (worktreePath: string): boolean => {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (!gitDir || !commonDir) return false;
    // A linked worktree has its own administrative Git dir beneath the
    // repository's common dir. A main checkout, submodule, or separate-git-dir
    // repository uses the same git dir and common dir and remains eligible.
    return !samePath(gitDir, commonDir);
  } catch {
    return false;
  }
};

/**
 * Snapshot the same hook-installation decisions as `installGitHooks` without
 * creating a hooks directory or changing a wrapper. `refresh plan` needs this
 * extra inspection because an existing non-GitNexus hook stops installation at
 * that event, rather than being overwritten.
 */
const getGitHookInstallPlanTargets = (worktreePath: string): RefreshWriteTarget[] => {
  const linkedWorktree = isLinkedWorktree(worktreePath);
  let hooksPath: string;
  try {
    hooksPath = getGitHooksDirectory(worktreePath);
  } catch (error: any) {
    return [
      {
        path: path.join(worktreePath, '.git'),
        purpose: `Git hook installation skipped: Git did not provide a hooks directory (${error?.message ?? String(error)}).`,
        willWrite: false,
      },
    ];
  }

  if (linkedWorktree) {
    return [
      {
        path: hooksPath,
        purpose:
          'Git hook installation skipped: linked worktree shares this hook directory with its primary checkout.',
        willWrite: false,
      },
    ];
  }

  const configuredHooksPath = getConfiguredHooksPath(worktreePath);
  const isHuskyDispatcher =
    path.basename(hooksPath) === '_' && path.basename(path.dirname(hooksPath)) === '.husky';
  if (configuredHooksPath && !isHuskyDispatcher) {
    return [
      {
        path: hooksPath,
        purpose: `Git hook installation skipped: core.hooksPath is configured as ${configuredHooksPath}; GitNexus will not overwrite an unknown dispatcher.`,
        willWrite: false,
      },
    ];
  }
  if (isHuskyDispatcher) {
    return [
      {
        path: hooksPath,
        purpose: `Git hook installation skipped: core.hooksPath is Husky (${configuredHooksPath}); tracked .husky/post-* files are untouched.`,
        willWrite: false,
      },
    ];
  }

  const cli = resolveCliInvocation();
  if (!cli) {
    return [
      {
        path: hooksPath,
        purpose: 'Git hook installation skipped: GitNexus CLI entrypoint could not be resolved.',
        willWrite: false,
      },
    ];
  }

  let hooksDirectoryExists = false;
  try {
    hooksDirectoryExists = statSync(hooksPath).isDirectory();
    if (!hooksDirectoryExists) {
      return [
        {
          path: hooksPath,
          purpose:
            'Git hook installation skipped: the resolved hooks path exists but is not a directory.',
          willWrite: false,
        },
      ];
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      return [
        {
          path: hooksPath,
          purpose: `Git hook installation skipped: could not inspect the resolved hooks directory (${error?.message ?? String(error)}).`,
          willWrite: false,
        },
      ];
    }
  }

  const targets: RefreshWriteTarget[] = [
    {
      path: hooksPath,
      purpose: hooksDirectoryExists
        ? 'Git hook directory already exists; no directory creation is needed'
        : 'Git hook directory for GitNexus-managed stale-marker wrappers',
      willWrite: !hooksDirectoryExists,
    },
  ];
  let blockedBy: string | undefined;
  for (const event of GIT_HOOK_EVENTS) {
    const targetPath = path.join(hooksPath, event);
    if (blockedBy) {
      targets.push({
        path: targetPath,
        purpose: `Git hook installation skipped because ${blockedBy} blocks the managed wrapper set.`,
        willWrite: false,
      });
      continue;
    }

    const expected = hookScript(event, cli);
    let current: string | undefined;
    try {
      current = readFileSync(targetPath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        blockedBy = targetPath;
        targets.push({
          path: targetPath,
          purpose: `Git hook installation skipped: could not inspect an existing hook (${error?.message ?? String(error)}).`,
          willWrite: false,
        });
        continue;
      }
    }

    if (current === undefined) {
      targets.push({
        path: targetPath,
        purpose: `GitNexus-managed ${event} stale-marker wrapper`,
        willWrite: true,
      });
      continue;
    }
    if (current === expected) {
      targets.push({
        path: targetPath,
        purpose: `GitNexus-managed ${event} wrapper already matches; no write is needed`,
        willWrite: false,
      });
      continue;
    }

    blockedBy = targetPath;
    targets.push({
      path: targetPath,
      purpose:
        'Git hook installation skipped: existing hook does not exactly match the GitNexus-managed wrapper and will not be overwritten.',
      willWrite: false,
    });
  }
  return targets;
};

/**
 * Install only idempotent, GitNexus-owned post hooks. A conventional Git
 * hooks directory is safe because wrappers determine the live worktree at
 * invocation. We deliberately do not modify Husky's sibling source-tree
 * scripts: those are tracked/project-owned files, not per-worktree runtime
 * state, and silently adding them would make `refresh init` create a diff.
 */
export const installGitHooks = async (worktreePath: string): Promise<HookInstallResult> => {
  if (isLinkedWorktree(worktreePath)) {
    return {
      installed: [],
      skipped:
        'This is a linked worktree, whose Git hook directory is shared with its primary checkout. ' +
        'GitNexus will not install a worktree-specific wrapper there; the Codex graph gate and HEAD freshness checks remain active.',
    };
  }
  const configuredHooksPath = getConfiguredHooksPath(worktreePath);
  const hooksPath = getGitHooksDirectory(worktreePath);
  const isHuskyDispatcher =
    path.basename(hooksPath) === '_' && path.basename(path.dirname(hooksPath)) === '.husky';
  if (configuredHooksPath && !isHuskyDispatcher) {
    return {
      installed: [],
      skipped:
        `core.hooksPath is configured as ${configuredHooksPath}; GitNexus will not overwrite an unknown hook dispatcher. ` +
        'Use the bundled gitnexus-git-hook.cjs template or add an equivalent mark command to that dispatcher.',
    };
  }

  if (isHuskyDispatcher) {
    return {
      installed: [],
      skipped:
        `core.hooksPath is Husky (${configuredHooksPath}); GitNexus will not write tracked .husky/post-* files. ` +
        'The Codex freshness gate and HEAD comparison remain active; add the bundled template to Husky explicitly if Git-side stale markers are required.',
    };
  }

  const targetDirectory = hooksPath;
  const cli = resolveCliInvocation();
  if (!cli) {
    return {
      installed: [],
      skipped: 'Could not resolve the installed GitNexus CLI entrypoint for managed Git hooks.',
    };
  }
  await fs.mkdir(targetDirectory, { recursive: true });
  const installed: string[] = [];

  for (const event of GIT_HOOK_EVENTS) {
    const targetPath = path.join(targetDirectory, event);
    const expected = hookScript(event, cli);
    let current: string | undefined;
    try {
      current = await fs.readFile(targetPath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (current !== undefined && current !== expected) {
      return {
        installed,
        skipped:
          `Existing ${targetPath} does not exactly match the GitNexus-managed wrapper; it was not modified. ` +
          'Add the bundled template to that hook manually if you want stale markers.',
      };
    }
    if (current !== expected) {
      await fs.writeFile(targetPath, expected, { mode: 0o755 });
      await fs.chmod(targetPath, 0o755);
    }
    installed.push(targetPath);
  }
  return { installed };
};

const runSerenaInitialization = async (
  worktreePath: string,
  options: RefreshOptions,
): Promise<void> => {
  validateSerenaOptions(options);
  const serenaLanguages = getSerenaLanguages(options);
  const serenaBin = options.serenaBin ?? process.env.GITNEXUS_SERENA_BIN;
  // validateSerenaOptions guarantees this is an absolute path.
  if (!serenaBin) throw new Error('Serena executable is not configured.');
  try {
    await fs.access(serenaBin);
  } catch {
    throw new Error(`Serena executable does not exist: ${serenaBin}`);
  }
  const serenaHome = getSerenaHome();
  await withFileLock(path.join(serenaHome, SERENA_LOCK_FILE), async () => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        serenaBin,
        [
          'project',
          'index',
          worktreePath,
          ...serenaLanguages.flatMap((language) => ['--language', language]),
        ],
        {
          cwd: worktreePath,
          stdio: ['ignore', 'inherit', 'inherit'],
        },
      );
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`Serena project index failed (${signal ?? `exit ${code ?? 'unknown'}`}).`),
          );
      });
    });
  });
};

const clearRequestLeaseForPid = async (
  worktreePath: string,
  pid: number | undefined,
): Promise<void> => {
  if (!pid) return;
  await withStateLock(worktreePath, async () => {
    const paths = getRefreshPaths(worktreePath);
    const state = await readState(paths, worktreePath);
    if (!state || state.requestPid !== pid) return;
    state.lastRequestAt = undefined;
    state.requestPid = undefined;
    state.requestExpiresAt = undefined;
    await writeJsonAtomically(paths.statePath, state);
  });
};

const queueEnsure = async (worktreePath: string, state: RefreshState): Promise<RequestState> => {
  const now = Date.now();
  const requestExpiresAt = Date.parse(state.requestExpiresAt ?? '');
  const processIsAlive = (pid: number | undefined): boolean => {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      // EPERM means another user owns a still-live process. It is active for
      // dedupe purposes; ESRCH means the detached worker has exited.
      return error?.code === 'EPERM';
    }
  };
  if (
    Number.isFinite(requestExpiresAt) &&
    requestExpiresAt > now &&
    processIsAlive(state.requestPid)
  ) {
    return 'already-queued';
  }
  // Backward-compatible short debounce for state written by an older
  // coordinator version, which did not record a child PID/lease.
  if (
    !state.requestPid &&
    state.lastRequestAt &&
    now - Date.parse(state.lastRequestAt) < REQUEST_DEBOUNCE_MS
  ) {
    return 'already-queued';
  }
  const invocation = resolveCliInvocation();
  if (!invocation) return 'unavailable';
  let child;
  try {
    child = spawn(
      invocation.command,
      [
        ...(invocation.command === process.execPath
          ? [`--max-old-space-size=${ANALYSIS_HEAP_MB}`]
          : []),
        ...invocation.args,
        'refresh',
        'ensure',
        '--path',
        worktreePath,
        '--json',
      ],
      {
        cwd: worktreePath,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${ANALYSIS_HEAP_MB}`.trim(),
        },
      },
    );
  } catch {
    return 'unavailable';
  }

  // `spawn` reports launch failures asynchronously. Attach the handler before
  // inspecting `pid` or writing the lease so an invalid executable cannot
  // surface as an unhandled ChildProcess error.
  const pid = child.pid;
  let launchFailed = false;
  child.once('error', () => {
    launchFailed = true;
    void clearRequestLeaseForPid(worktreePath, pid).catch(() => {});
  });
  child.once('exit', (code) => {
    // Normal `ensure` clears its own lease on success/failure. This is a
    // crash/early-entrypoint fallback for cases that never reach ensure.
    if (code !== 0) void clearRequestLeaseForPid(worktreePath, pid).catch(() => {});
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (launchFailed || !pid) return 'unavailable';
  child.unref();
  state.lastRequestAt = new Date(now).toISOString();
  state.requestPid = pid;
  state.requestExpiresAt = new Date(now + REQUEST_LEASE_MS).toISOString();
  await writeJsonAtomically(getRefreshPaths(worktreePath).statePath, state);
  return 'queued';
};

const initialize = async (
  worktreePath: string,
  options: RefreshOptions,
): Promise<RefreshStatus> => {
  // Validate every optional Serena argument before `init` creates any graph
  // coordinator state. A caller can inspect the same contract via `plan`.
  validateSerenaOptions(options);
  let state: RefreshState;
  await withStateLock(worktreePath, async () => {
    state = await ensureState(worktreePath, options.alias);
  });
  const hooks = options.installGitHooks ? await installGitHooks(worktreePath) : undefined;
  if (options.withSerena) {
    await runSerenaInitialization(worktreePath, options);
    await withStateLock(worktreePath, async () => {
      const current = await ensureState(worktreePath, options.alias);
      current.serenaInitializedAt = new Date().toISOString();
      await writeJsonAtomically(getRefreshPaths(worktreePath).statePath, current);
      state = current;
    });
  }
  const status = await getRefreshStatus(worktreePath);
  print(
    options.json
      ? { ...status, hooks }
      : `Initialized ${worktreePath}\n  Alias: ${state!.alias}\n  Refresh: gitnexus refresh ensure --path ${worktreePath}${
          hooks?.skipped
            ? `\n  Git hooks: ${hooks.skipped}`
            : hooks
              ? `\n  Git hooks: ${hooks.installed.length} managed hook(s)`
              : ''
        }`,
    options,
  );
  return status;
};

const mark = async (worktreePath: string, options: RefreshOptions): Promise<RefreshStatus> => {
  let initialized = false;
  const paths = getRefreshPaths(worktreePath);
  // Do this lock-free first. `withFileLock` has to create its parent
  // directory, which would itself violate the “global hooks never create
  // .gitnexus in an unrelated repo” boundary.
  if (!(await readState(paths, worktreePath))) {
    const status = await getRefreshStatus(worktreePath);
    print(options.json ? { ...status, marked: false } : status, options);
    return status;
  }
  await withStateLock(worktreePath, async () => {
    const state = await readState(paths, worktreePath);
    // Git/Codex hooks are global. Never let an incidental `git commit` in an
    // unrelated repository create .gitnexus state: explicit `refresh init`
    // (or an on-demand graph `request`) establishes that opt-in boundary.
    if (!state) return;
    initialized = true;
    await writeStaleMarker(worktreePath, options.reason ?? 'manual');
  });
  const status = await getRefreshStatus(worktreePath);
  print(options.json ? { ...status, marked: initialized } : status, options);
  return status;
};

/**
 * A queued worker owns the request lease with its own PID. Clear that lease
 * on failure so a later gated graph query can queue a retry; never erase a
 * newer worker's lease from an unrelated manual `ensure` invocation.
 */
const clearFailedRequestLease = async (worktreePath: string): Promise<void> => {
  await clearRequestLeaseForPid(worktreePath, process.pid);
};

const ensure = async (worktreePath: string, options: RefreshOptions): Promise<RefreshStatus> => {
  let state!: RefreshState;
  let markerSnapshot: string[] = [];
  await withStateLock(worktreePath, async () => {
    state = await ensureState(worktreePath, options.alias);
    markerSnapshot = await readStaleMarkerNames(getRefreshPaths(worktreePath));
  });

  let result: Awaited<ReturnType<typeof runFullAnalysis>>;
  try {
    result = await runFullAnalysis(
      worktreePath,
      {
        // A stale marker can represent uncommitted source edits, so HEAD-only
        // freshness is insufficient here. Keep the refresh index-only, but
        // force the pipeline whenever the coordinator observed a marker.
        force: Boolean(options.force || markerSnapshot.length > 0),
        indexOnly: true,
        // A coordinator refresh may load a pre-installed FTS extension, but
        // it must never spawn DuckDB INSTALL or populate external extension
        // caches/network state. Direct `gitnexus analyze` retains `auto`.
        extensionInstallPolicy: 'load-only',
        suppressEmbeddingGeneration: true,
        // A detached, demand-driven refresh must remain reliable even when a
        // native tree-sitter worker is terminated for an idle-timeout retry.
        // Keep this explicit at the coordinator boundary; direct `analyze`
        // retains its worker-pool performance default.
        skipWorkers: true,
        registryName: state.alias,
      },
      { onProgress: () => {} },
    );
  } catch (error) {
    await clearFailedRequestLease(worktreePath).catch(() => {});
    throw error;
  }

  // `runFullAnalysis` intentionally fast-returns on a healthy current graph.
  // A coordinator still needs to repair/register its unique worktree alias in
  // that case so an existing manually-created index becomes addressable.
  if (result.alreadyUpToDate) {
    const meta = await loadMeta(getRefreshPaths(worktreePath).storagePath);
    if (meta) await registerRepo(worktreePath, meta, { name: state.alias });
  }

  await withStateLock(worktreePath, async () => {
    const latest = await ensureState(worktreePath, options.alias);
    latest.lastEnsureAt = new Date().toISOString();
    latest.lastEnsureCommit = getCurrentCommit(worktreePath) || undefined;
    // A foreground/manual ensure may finish while a queued worker is still
    // waiting for the analysis lock. Do not erase that worker's lease: doing
    // so would let a later graph query spawn redundant writers.
    if (!latest.requestPid || latest.requestPid === process.pid) {
      latest.lastRequestAt = undefined;
      latest.requestPid = undefined;
      latest.requestExpiresAt = undefined;
    }
    await writeJsonAtomically(getRefreshPaths(worktreePath).statePath, latest);
    // Do not remove markers written while the graph was rebuilding: they may
    // describe a newer commit and must force the next graph query to refresh.
    await clearStaleMarkers(getRefreshPaths(worktreePath), markerSnapshot);
  });

  const status = await getRefreshStatus(worktreePath);
  print(status, options);
  return status;
};

const request = async (worktreePath: string, options: RefreshOptions): Promise<RefreshStatus> => {
  const requestState: RequestState = await withStateLock(worktreePath, async () => {
    const state = await ensureState(worktreePath, options.alias);
    return queueEnsure(worktreePath, state);
  });
  const status = {
    ...(await getRefreshStatus(worktreePath)),
    queued: requestState === 'queued',
    requestState,
  };
  print(status, options);
  return status;
};

export const refreshCommand = async (actionInput: string, options: RefreshOptions = {}) => {
  const action = actionInput as RefreshAction;
  if (!['init', 'mark', 'status', 'plan', 'ensure', 'request'].includes(action)) {
    console.error('Unknown refresh action. Use one of: init, mark, status, plan, ensure, request.');
    process.exitCode = 1;
    return;
  }
  try {
    validateRefreshHome();
    if (action === 'ensure' && !process.env.GITNEXUS_REFRESH_HEAP_READY && ensureAnalysisHeap()) {
      return;
    }
    const worktreePath = await resolveWorktreePath(options.path);
    switch (action) {
      case 'init':
        await initialize(worktreePath, options);
        return;
      case 'mark':
        await mark(worktreePath, options);
        return;
      case 'status':
        print(await getRefreshStatus(worktreePath), options);
        return;
      case 'plan':
        print(getRefreshPlan(worktreePath, options), options);
        return;
      case 'ensure':
        await ensure(worktreePath, options);
        return;
      case 'request':
        await request(worktreePath, options);
        return;
    }
  } catch (error: any) {
    console.error(`GitNexus refresh failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
};
