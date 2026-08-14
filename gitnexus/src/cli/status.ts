/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import fs from 'fs/promises';
import path from 'path';
import {
  findRepo,
  getIndexHealth,
  getStoragePaths,
  hasKuzuIndex,
  type IndexedRepo,
} from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';
import {
  GITNEXUS_CONTEXT_VERSION_MARKER,
  MANAGED_SKILLS_MARKER_FILE,
  getInstalledManagedSkillsFingerprint,
  getManagedSkillsFingerprint,
} from './ai-context.js';

const GITNEXUS_START_MARKER = '<!-- gitnexus:start -->';
const GITNEXUS_END_MARKER = '<!-- gitnexus:end -->';
const GENERATED_SKILLS_COMMIT_FILE = '.gitnexus-generated-commit';
const GENERATED_SKILL_PREFIX = 'gitnexus-generated-';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

type AssetFreshness = 'missing' | 'stale' | 'current';

const markerLineIndices = (content: string, marker: string): number[] =>
  content
    .split(/\r?\n/)
    .map((line, index) => (line === marker ? index : -1))
    .filter((index) => index >= 0);

const getGitNexusSectionFreshness = async (filePath: string): Promise<AssetFreshness> => {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'stale';
    const content = await fs.readFile(filePath, 'utf-8');
    const starts = markerLineIndices(content, GITNEXUS_START_MARKER);
    const ends = markerLineIndices(content, GITNEXUS_END_MARKER);
    if (starts.length === 0 && ends.length === 0) return 'missing';
    if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) return 'stale';
    const versions = markerLineIndices(content, GITNEXUS_CONTEXT_VERSION_MARKER);
    return versions.length === 1 && versions[0] > starts[0] && versions[0] < ends[0]
      ? 'current'
      : 'stale';
  } catch {
    return 'missing';
  }
};

const formatStats = (repo: IndexedRepo): string | undefined => {
  const stats = repo.meta.stats;
  if (!stats) return undefined;

  const parts: string[] = [];
  if (stats.files !== undefined) parts.push(`${stats.files} files`);
  if (stats.nodes !== undefined) parts.push(`${stats.nodes} symbols`);
  if (stats.edges !== undefined) parts.push(`${stats.edges} edges`);
  if (stats.communities !== undefined) parts.push(`${stats.communities} communities`);
  if (stats.processes !== undefined) parts.push(`${stats.processes} processes`);

  return parts.length > 0 ? `Stats: ${parts.join(', ')}` : undefined;
};

const getEmbeddingCount = (repo: IndexedRepo): number | undefined => repo.meta.stats?.embeddings;

const getVectorSearchStatus = (repo: IndexedRepo): string => {
  const explicit = repo.meta.capabilities?.vectorSearch?.status;
  if (explicit) return explicit;

  const embeddings = getEmbeddingCount(repo);
  if (embeddings === undefined) return 'unknown';
  return embeddings > 0 ? 'unknown' : 'unavailable';
};

const getFtsStatus = (repo: IndexedRepo): string =>
  repo.meta.capabilities?.fts?.status ?? 'unknown';

const readCommitMarkerFreshness = async (
  markerPath: string,
  indexedCommit: string,
): Promise<'stale' | 'current'> => {
  try {
    const stat = await fs.lstat(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'stale';
    const marker = (await fs.readFile(markerPath, 'utf-8')).trim();
    return marker === indexedCommit ? 'current' : 'stale';
  } catch {
    return 'stale';
  }
};

const getManagedSkillsFreshness = async (repoPath: string): Promise<AssetFreshness> => {
  const skillsDir = path.join(repoPath, '.agents', 'skills');
  try {
    const installedFingerprint = await getInstalledManagedSkillsFingerprint(repoPath);
    if (!installedFingerprint) return 'missing';
    const expectedFingerprint = await getManagedSkillsFingerprint();
    const markerPath = path.join(skillsDir, MANAGED_SKILLS_MARKER_FILE);
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return 'stale';
    const marker = (await fs.readFile(markerPath, 'utf-8')).trim();
    return marker === expectedFingerprint && installedFingerprint === expectedFingerprint
      ? 'current'
      : 'stale';
  } catch {
    return 'stale';
  }
};

type GeneratedSkillsFreshness = AssetFreshness | 'not-generated';

const getGeneratedSkillsFreshness = async (
  repoPath: string,
  indexedCommit: string,
): Promise<GeneratedSkillsFreshness> => {
  const skillsDir = path.join(repoPath, '.agents', 'skills');
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const generatedSkills = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(GENERATED_SKILL_PREFIX),
    );
    if (generatedSkills.length === 0) return 'not-generated';

    const skillFiles = await Promise.all(
      generatedSkills.map(async (entry) => {
        try {
          const stat = await fs.lstat(path.join(skillsDir, entry.name, 'SKILL.md'));
          return stat.isFile() && !stat.isSymbolicLink();
        } catch {
          return false;
        }
      }),
    );
    if (skillFiles.some((present) => !present)) return 'missing';
    return readCommitMarkerFreshness(
      path.join(skillsDir, GENERATED_SKILLS_COMMIT_FILE),
      indexedCommit,
    );
  } catch {
    return 'not-generated';
  }
};

const formatAgentHelpers = async (
  repoPath: string,
  indexedCommit: string,
): Promise<{ line: string; needsManagedRefresh: boolean; needsGeneratedRefresh: boolean }> => {
  const agents = await getGitNexusSectionFreshness(path.join(repoPath, 'AGENTS.md'));
  const managedSkills = await getManagedSkillsFreshness(repoPath);
  const generatedSkills = await getGeneratedSkillsFreshness(repoPath, indexedCommit);

  return {
    line:
      `Agent helpers: AGENTS.md ${agents}, managed skills ${managedSkills}, ` +
      `generated skills ${generatedSkills}`,
    needsManagedRefresh: agents !== 'current' || managedSkills !== 'current',
    needsGeneratedRefresh: generatedSkills !== 'current' && generatedSkills !== 'not-generated',
  };
};

const printEnrichmentStatus = async (
  repo: IndexedRepo,
  isUpToDate: boolean,
  indexHealthy: boolean,
) => {
  const statsLine = formatStats(repo);
  if (statsLine) console.log(statsLine);

  const embeddings = getEmbeddingCount(repo);
  console.log(`Embeddings: ${embeddings ?? 'unknown'}`);
  console.log(`Vector search: ${getVectorSearchStatus(repo)}`);
  console.log(`FTS: ${getFtsStatus(repo)}`);

  const helpers = await formatAgentHelpers(repo.repoPath, repo.meta.lastCommit);
  console.log(helpers.line);
  if (!indexHealthy) return;

  const analyzePrefix = isUpToDate ? 'gitnexus analyze --force' : 'gitnexus analyze';
  const lacksEmbeddings = embeddings === undefined || embeddings <= 0;

  if (lacksEmbeddings) {
    console.log(
      `Recommendation: run ${analyzePrefix} --embeddings for semantic/vector search on important repos.`,
    );
  } else if (!isUpToDate) {
    console.log(
      'Recommendation: run gitnexus analyze --embeddings to refresh the stale graph and generate embeddings for new/changed symbols.',
    );
  }

  if (helpers.needsManagedRefresh) {
    console.log(
      `Recommendation: run gitnexus agent-context plan --path ${shellQuote(repo.repoPath)} ` +
        'to review repo-local AGENTS.md and managed skills changes.',
    );
  }

  if (helpers.needsGeneratedRefresh) {
    console.log(`Recommendation: run ${analyzePrefix} --skills to refresh generated repo skills.`);
  }
};

const getHealthRecoveryCommands = (repo: IndexedRepo): { primary: string; fallback: string } => {
  const suffix = (repo.meta.stats?.embeddings ?? 0) > 0 ? ' --embeddings' : '';
  return {
    primary: `gitnexus analyze${suffix}`,
    fallback: `gitnexus clean --force && gitnexus analyze${suffix}`,
  };
};

export const statusCommand = async () => {
  const cwd = process.cwd();

  if (!isGitRepo(cwd)) {
    console.log('Not a git repository.');
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    // Check if there's a stale KuzuDB index that needs migration
    const repoRoot = getGitRoot(cwd) ?? cwd;
    const { storagePath } = getStoragePaths(repoRoot);
    if (await hasKuzuIndex(storagePath)) {
      console.log('Repository has a stale KuzuDB index from a previous version.');
      console.log('Run: gitnexus analyze   (rebuilds the index with LadybugDB)');
    } else {
      console.log('Repository not indexed.');
      console.log('Run: gitnexus analyze');
    }
    return;
  }

  const currentCommit = getCurrentCommit(repo.repoPath);
  const isUpToDate = currentCommit === repo.meta.lastCommit;
  const health = await getIndexHealth(repo.repoPath);

  console.log(`Repository: ${repo.repoPath}`);
  console.log(`Indexed: ${new Date(repo.meta.indexedAt).toLocaleString()}`);
  console.log(`Indexed commit: ${repo.meta.lastCommit?.slice(0, 7)}`);
  console.log(`Current commit: ${currentCommit?.slice(0, 7)}`);
  await printEnrichmentStatus(repo, isUpToDate, health.ok);

  if (!health.ok) {
    const recovery = getHealthRecoveryCommands(repo);
    console.log('Index health: ⚠️ incomplete or interrupted');
    console.log(`Reason: ${health.message ?? health.reason}`);
    console.log(`Run: ${recovery.primary}`);
    console.log(`Fallback if analyze still fails: ${recovery.fallback}`);
    return;
  }

  console.log(`Status: ${isUpToDate ? '✅ up-to-date' : '⚠️ stale (re-run gitnexus analyze)'}`);
};
