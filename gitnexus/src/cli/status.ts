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

const GITNEXUS_START_MARKER = '<!-- gitnexus:start -->';
const GITNEXUS_END_MARKER = '<!-- gitnexus:end -->';

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const hasGitNexusSection = async (filePath: string): Promise<boolean> => {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.includes(GITNEXUS_START_MARKER) && content.includes(GITNEXUS_END_MARKER);
  } catch {
    return false;
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

const getFtsStatus = (repo: IndexedRepo): string => repo.meta.capabilities?.fts?.status ?? 'unknown';

const hasRepoLocalSkills = async (repoPath: string): Promise<boolean> => {
  return (
    (await fileExists(path.join(repoPath, '.claude', 'skills', 'gitnexus'))) ||
    (await fileExists(path.join(repoPath, '.claude', 'skills', 'generated')))
  );
};

const formatAgentHelpers = async (repoPath: string): Promise<{ line: string; missing: boolean }> => {
  const agents = await hasGitNexusSection(path.join(repoPath, 'AGENTS.md'));
  const claude = await hasGitNexusSection(path.join(repoPath, 'CLAUDE.md'));
  const skills = await hasRepoLocalSkills(repoPath);

  return {
    line: `Agent helpers: AGENTS.md ${agents ? 'present' : 'missing'}, CLAUDE.md ${
      claude ? 'present' : 'missing'
    }, skills ${skills ? 'present' : 'missing'}`,
    missing: !agents || !claude || !skills,
  };
};

const printEnrichmentStatus = async (repo: IndexedRepo, isUpToDate: boolean) => {
  const statsLine = formatStats(repo);
  if (statsLine) console.log(statsLine);

  const embeddings = getEmbeddingCount(repo);
  console.log(`Embeddings: ${embeddings ?? 'unknown'}`);
  console.log(`Vector search: ${getVectorSearchStatus(repo)}`);
  console.log(`FTS: ${getFtsStatus(repo)}`);

  const helpers = await formatAgentHelpers(repo.repoPath);
  console.log(helpers.line);

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

  if (helpers.missing) {
    console.log(
      `Recommendation: run ${analyzePrefix} --skills if you want repo-local AGENTS/CLAUDE/.claude helper files for non-Hermes agents.`,
    );
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
  await printEnrichmentStatus(repo, isUpToDate);

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
