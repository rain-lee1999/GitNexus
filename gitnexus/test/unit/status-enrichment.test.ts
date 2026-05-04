import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { statusCommand } from '../../src/cli/status.js';
import { getStoragePaths, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

describe('statusCommand enrichment reporting', () => {
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let originalCwd: string;
  let logs: string[];

  beforeEach(async () => {
    tmpRepo = await createTempDir('gn-status-enrichment-');
    originalCwd = process.cwd();
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ''));
    });

    execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
    execSync('git -c user.name=test -c user.email=test@test commit --allow-empty -m init', {
      cwd: tmpRepo.dbPath,
      stdio: 'pipe',
    });
    process.chdir(tmpRepo.dbPath);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await tmpRepo.cleanup();
  });

  async function writeHealthyMeta(meta: RepoMeta) {
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    await saveMeta(storagePath, meta);
    await fs.writeFile(lbugPath, 'db');
  }

  it('shows embeddings/vector/FTS capability state and no enrichment recommendation when already enriched', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();

    await fs.mkdir(path.join(tmpRepo.dbPath, '.claude', 'skills', 'gitnexus'), { recursive: true });
    await fs.writeFile(path.join(tmpRepo.dbPath, 'AGENTS.md'), '<!-- gitnexus:start -->\nctx\n<!-- gitnexus:end -->\n');
    await fs.writeFile(path.join(tmpRepo.dbPath, 'CLAUDE.md'), '<!-- gitnexus:start -->\nctx\n<!-- gitnexus:end -->\n');

    await writeHealthyMeta({
      repoPath: tmpRepo.dbPath,
      lastCommit: currentCommit,
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { files: 4, nodes: 5, edges: 6, communities: 7, processes: 8, embeddings: 9 },
      capabilities: {
        graph: { provider: 'ladybugdb', status: 'available' },
        fts: { provider: 'ladybugdb-fts', status: 'available' },
        vectorSearch: { provider: 'ladybugdb-vector', status: 'vector-index' },
      },
    } as RepoMeta);

    await statusCommand();

    const output = logs.join('\n');
    expect(output).toContain('Stats: 4 files, 5 symbols, 6 edges, 7 communities, 8 processes');
    expect(output).toContain('Embeddings: 9');
    expect(output).toContain('Vector search: vector-index');
    expect(output).toContain('FTS: available');
    expect(output).toContain('Agent helpers: AGENTS.md present, CLAUDE.md present, skills present');
    expect(output).not.toContain('Recommendation: run gitnexus analyze --force --embeddings');
    expect(output).not.toContain('Recommendation: run gitnexus analyze --force --skills');
  });

  it('recommends embeddings and skills commands when an up-to-date index lacks enrichment', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();

    await writeHealthyMeta({
      repoPath: tmpRepo.dbPath,
      lastCommit: currentCommit,
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { files: 1, nodes: 2, edges: 3, embeddings: 0 },
    });

    await statusCommand();

    const output = logs.join('\n');
    expect(output).toContain('Embeddings: 0');
    expect(output).toContain('Vector search: unavailable');
    expect(output).toContain('FTS: unknown');
    expect(output).toContain('Agent helpers: AGENTS.md missing, CLAUDE.md missing, skills missing');
    expect(output).toContain('Recommendation: run gitnexus analyze --force --embeddings');
    expect(output).toContain('Recommendation: run gitnexus analyze --force --skills');
  });
});
