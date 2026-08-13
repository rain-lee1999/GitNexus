import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { deriveEmbeddingMode } from '../../src/core/embedding-mode.js';
import {
  getStoragePaths,
  registerRepo,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

describe('run-analyze module', () => {
  it('exports runFullAnalysis as a function', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runFullAnalysis).toBe('function');
  });

  it('exports PHASE_LABELS', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(mod.PHASE_LABELS).toBeDefined();
    expect(mod.PHASE_LABELS.parsing).toBe('Parsing code');
  });

  it('creates .gitnexus/.gitignore on the already-up-to-date fast path (#1233)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-fast-path-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-fast-path-home-');
    const savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
      };
      await saveMeta(storagePath, meta);
      await fs.writeFile(lbugPath, 'db');

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        {},
        {
          onProgress: () => {},
        },
      );

      expect(result.alreadyUpToDate).toBe(true);
      await expect(
        fs.readFile(path.join(tmpRepo.dbPath, '.gitnexus', '.gitignore'), 'utf-8'),
      ).resolves.toBe('*\n');
    } finally {
      if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedGitnexusHome;
      await tmpRepo.cleanup();
      await tmpHome.cleanup();
    }
  });

  it('keeps a preserved coordinator registry alias out of generated AGENTS context', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-context-name-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-context-name-home-');
    const savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      await fs.writeFile(path.join(tmpRepo.dbPath, 'index.ts'), 'export const value = 1;\n');
      execSync('git add index.ts', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const coordinatorAlias = `${path.basename(tmpRepo.dbPath)}-coordinator-1234`;
      await registerRepo(
        tmpRepo.dbPath,
        {
          repoPath: tmpRepo.dbPath,
          lastCommit: currentCommit,
          indexedAt: new Date().toISOString(),
        },
        { name: coordinatorAlias },
      );

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        {},
        {
          onProgress: () => {},
        },
      );

      const contextName = path.basename(tmpRepo.dbPath);
      expect(result.repoName).toBe(coordinatorAlias);
      expect(result.contextName).toBe(contextName);
      const agents = await fs.readFile(path.join(tmpRepo.dbPath, 'AGENTS.md'), 'utf-8');
      expect(agents).toContain(`indexed by GitNexus as **${contextName}**`);
      expect(agents).toContain(`gitnexus://repo/${contextName}/context`);
      expect(agents).not.toContain(coordinatorAlias);
    } finally {
      if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedGitnexusHome;
      await tmpRepo.cleanup();
      await tmpHome.cleanup();
    }
  });

  it('rebuilds instead of taking the fast path when current metadata has leftover LadybugDB WAL', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-unhealthy-fast-path-');
    const tmpHome = await createTempDir('gitnexus-run-analyze-index-only-home-');
    const savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      await fs.writeFile(path.join(tmpRepo.dbPath, 'index.ts'), 'export const value = 1;\n');
      const agentsPath = path.join(tmpRepo.dbPath, 'AGENTS.md');
      const manualAgents = '# Manual agent instructions\n';
      await fs.writeFile(agentsPath, manualAgents, 'utf-8');
      execSync('git add index.ts', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date('2026-05-04T00:00:00.000Z').toISOString(),
        stats: { files: 1, nodes: 1, edges: 0 },
      };
      await saveMeta(storagePath, meta);
      await fs.writeFile(lbugPath, 'old-db');
      await fs.writeFile(`${lbugPath}.wal`, 'partial wal');

      const logs: string[] = [];
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { indexOnly: true },
        {
          onProgress: () => {},
          onLog: (msg) => logs.push(msg),
        },
      );

      expect(result.alreadyUpToDate).toBeUndefined();
      expect(logs.join('\n')).toContain('index health is not OK');
      await expect(fs.stat(`${lbugPath}.wal`)).rejects.toMatchObject({ code: 'ENOENT' });
      // The automatic refresh mode must be a true index-only operation: no
      // generated AGENTS block and no repo-scoped skill directory.
      expect(await fs.readFile(agentsPath, 'utf-8')).toBe(manualAgents);
      await expect(fs.access(path.join(tmpRepo.dbPath, '.agents', 'skills'))).rejects.toThrow();
    } finally {
      if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedGitnexusHome;
      await tmpRepo.cleanup();
      await tmpHome.cleanup();
    }
  });
});

describe('deriveEmbeddingMode', () => {
  // Default `analyze` on a repo with existing embeddings: must preserve, must
  // NOT regenerate, must load the cache so phase 3.5 can re-insert vectors.
  it('default + existing>0 → preserve only (load cache, no generation)', () => {
    const m = deriveEmbeddingMode({}, 1234);
    expect(m.preserveExistingEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('default + existing=0 → no-op (no preserve, no generation, no cache load)', () => {
    const m = deriveEmbeddingMode({}, 0);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  // The headline behavior change requested in PR feedback: --force on an
  // already-embedded repo must regenerate (top up new/changed nodes), not
  // silently downgrade to "preserve only".
  it('--force + existing>0 → forceRegenerate + generate + load cache', () => {
    const m = deriveEmbeddingMode({ force: true }, 500);
    expect(m.forceRegenerateEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('coordinator refresh suppresses generation even when its graph rebuild is forced', () => {
    const m = deriveEmbeddingMode({ force: true, suppressEmbeddingGeneration: true }, 500);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(true);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--force + existing=0 → no embedding work (force keeps prior semantics)', () => {
    const m = deriveEmbeddingMode({ force: true }, 0);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  it('--embeddings → generate + load cache (incremental top-up)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 500);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--embeddings + existing=0 → generate; cache load still fires (harmless empty load)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 0);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    // Cache load is gated at the call site by `existingMeta`, not by count;
    // when explicit `--embeddings` is set we always attempt the load so any
    // stray vectors from a partial prior run get picked up.
    expect(m.shouldLoadCache).toBe(true);
  });

  // --drop-embeddings is the explicit wipe path; it must suppress cache load
  // even when --force is also set (the dominant escape hatch).
  it('--drop-embeddings → suppresses cache load, no generation', () => {
    const m = deriveEmbeddingMode({ dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--force + --drop-embeddings → drop wins (no cache load, no generation)', () => {
    const m = deriveEmbeddingMode({ force: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--embeddings + --drop-embeddings → drop suppresses cache load (no preservation)', () => {
    // --embeddings still generates, but the prior vectors are wiped first.
    const m = deriveEmbeddingMode({ embeddings: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
  });
});
