import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveSpawnInvocation } from './command-invocation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DIST_CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

export interface UpdateOptions {
  check?: boolean;
  simple?: boolean;
  setup?: boolean;
  yes?: boolean;
}

interface UpdateSource {
  repo: string | null;
  compareRef: string;
  fetchArgs: string[];
  pullArgs: string[];
  label: string;
}

function execGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runCommand(command: string, args: string[], cwd: string): void {
  const invocation = resolveSpawnInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function isGitCheckout(candidate: string): boolean {
  try {
    return fs.existsSync(path.join(candidate, '.git'));
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

export function resolveLocalUpdateSourceRepo(repoRoot: string): string | null {
  const candidates: string[] = [];
  const envSource = (process.env.GITNEXUS_UPDATE_SOURCE_REPO || '').trim();
  if (envSource) candidates.push(path.resolve(envSource));

  const parent = path.dirname(repoRoot);
  const base = path.basename(repoRoot);
  if (base.endsWith('-update')) {
    candidates.push(path.join(parent, base.slice(0, -'-update'.length)));
  }
  candidates.push(path.join(parent, 'GitNexus'));
  candidates.push(path.join(os.homedir(), 'dev', '-github', 'GitNexus'));

  for (const candidate of uniquePaths(candidates)) {
    if (path.resolve(candidate) === path.resolve(repoRoot)) continue;
    if (isGitCheckout(candidate)) return candidate;
  }
  return null;
}

function getRepoRoot(): string {
  return execGit(['rev-parse', '--show-toplevel'], PACKAGE_ROOT);
}

function getUpdateSource(repoRoot: string): UpdateSource {
  const localRepo = resolveLocalUpdateSourceRepo(repoRoot);
  if (localRepo) {
    return {
      repo: localRepo,
      compareRef: 'FETCH_HEAD',
      fetchArgs: ['fetch', '--quiet', localRepo, 'main'],
      pullArgs: ['pull', '--ff-only', localRepo, 'main'],
      label: localRepo,
    };
  }
  return {
    repo: null,
    compareRef: 'origin/main',
    fetchArgs: ['fetch', 'origin'],
    pullArgs: ['pull', '--ff-only', 'origin', 'main'],
    label: 'origin/main',
  };
}

function changedFiles(repoRoot: string, compareRef: string): string[] {
  const raw = execGit(['diff', '--name-only', 'HEAD', compareRef, '--'], repoRoot);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasDependencyManifestChange(files: string[]): boolean {
  return files.some(
    (file) =>
      file === 'gitnexus/package.json' ||
      file === 'gitnexus/package-lock.json' ||
      file === 'gitnexus/npm-shrinkwrap.json' ||
      file === 'gitnexus-shared/package.json' ||
      file === 'gitnexus-web/package.json' ||
      file === 'gitnexus-web/package-lock.json',
  );
}

function hasSetupSensitiveChange(files: string[]): boolean {
  return files.some(
    (file) =>
      file === 'gitnexus/src/cli/setup.ts' ||
      file.startsWith('gitnexus/skills/') ||
      file.startsWith('gitnexus/hooks/') ||
      file.startsWith('gitnexus/vendor/') ||
      file === 'gitnexus/package.json',
  );
}

function stashLocalChangesIfNeeded(repoRoot: string): string | null {
  const status = execGit(['status', '--porcelain'], repoRoot);
  if (!status) return null;
  const before = execGit(['rev-parse', '--short', 'HEAD'], repoRoot);
  execGit(
    ['stash', 'push', '--include-untracked', '-m', `gitnexus update auto-stash ${before}`],
    repoRoot,
  );
  return before;
}

function restoreStashIfNeeded(repoRoot: string, marker: string | null): void {
  if (!marker) return;
  try {
    execGit(['stash', 'pop'], repoRoot);
  } catch (err: any) {
    console.log('  ⚠ Local changes are still in git stash; restore manually with: git stash pop');
    if (err?.message) console.log(`    ${err.message.split('\n')[0]}`);
  }
}

function installDependencies(): void {
  console.log('→ Installing dependencies...');
  runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], PACKAGE_ROOT);
}

function buildAndInstall(): void {
  console.log('→ Building GitNexus...');
  runCommand(process.execPath, ['scripts/build.js'], PACKAGE_ROOT);
  console.log('→ Installing global gitnexus...');
  runCommand(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '-g', '.'],
    PACKAGE_ROOT,
  );
}

function runSetup(): void {
  console.log('→ Running gitnexus setup...');
  runCommand(process.execPath, [DIST_CLI, 'setup'], PACKAGE_ROOT);
}

export async function updateCommand(options: UpdateOptions = {}): Promise<void> {
  const repoRoot = getRepoRoot();
  const source = getUpdateSource(repoRoot);

  console.log('');
  console.log('  GitNexus Update');
  console.log('  ===============');
  console.log('');
  console.log(`  Package: ${PACKAGE_ROOT}`);
  console.log(`  Repo:    ${repoRoot}`);
  console.log(`  Source:  ${source.label}`);
  console.log('');

  console.log('→ Fetching updates...');
  execGit(source.fetchArgs, repoRoot);

  const commitCount = Number(
    execGit(['rev-list', `HEAD..${source.compareRef}`, '--count'], repoRoot) || '0',
  );
  if (options.check) {
    if (commitCount === 0) {
      console.log('✓ Already up to date');
    } else {
      console.log(`→ ${commitCount} update commit(s) available from ${source.label}`);
    }
    return;
  }

  if (commitCount === 0) {
    console.log('✓ Already up to date');
    if (options.setup) {
      runSetup();
    }
    return;
  }

  const files = changedFiles(repoRoot, source.compareRef);
  const needsFullUpdate = hasDependencyManifestChange(files);
  const needsSetup = hasSetupSensitiveChange(files);

  console.log(`→ Found ${commitCount} new commit(s)`);

  const stashMarker = stashLocalChangesIfNeeded(repoRoot);
  try {
    console.log('→ Pulling updates...');
    execGit(source.pullArgs, repoRoot);
  } finally {
    restoreStashIfNeeded(repoRoot, stashMarker);
  }

  if (options.simple) {
    if (needsFullUpdate) {
      console.log('');
      console.log('⚠ Simple update detected dependency manifest changes.');
      console.log('  Run: gitnexus update');
      console.log('  Reason: npm dependencies may need reinstall before rebuild.');
      return;
    }

    buildAndInstall();
    console.log('');
    console.log('✓ GitNexus updated (simple mode).');
    console.log('  Skipped: npm install, setup, analyze, MCP reload.');
    if (needsSetup && !options.setup) {
      console.log('');
      console.log('⚠ Setup-sensitive files changed.');
      console.log('  Run: gitnexus update --setup');
      console.log('  Reason: MCP/editor setup, hooks, or packaged skills may need refresh.');
    }
    if (options.setup) runSetup();
    return;
  }

  installDependencies();
  buildAndInstall();

  if (options.setup) {
    runSetup();
  } else if (needsSetup) {
    console.log('');
    console.log('⚠ Setup-sensitive files changed.');
    console.log('  Run: gitnexus update --setup');
    console.log('  Reason: MCP/editor setup, hooks, or packaged skills may need refresh.');
  }

  console.log('');
  console.log('✓ GitNexus update complete.');
  console.log(
    '  Skipped: analyze. Run `gitnexus analyze` separately for repos that need re-indexing.',
  );
}
