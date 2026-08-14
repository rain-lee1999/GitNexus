import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import {
  cleanupLbugArtifacts,
  createAnalysisIncompleteMarker,
  createTempLbugPath,
  getIndexHealth,
  getStoragePaths,
  promoteLbugDatabase,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

describe('LadybugDB index health and promotion', () => {
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => {
    tmpRepo = await createTempDir('gn-lbug-health-');
  });

  afterEach(async () => {
    await tmpRepo.cleanup();
  });

  it('reports a leftover WAL as unhealthy even when meta.json says the commit is indexed', async () => {
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    const meta: RepoMeta = {
      repoPath: tmpRepo.dbPath,
      lastCommit: 'deadbeef',
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { files: 1, nodes: 2, edges: 3 },
    };

    await saveMeta(storagePath, meta);
    await fs.writeFile(lbugPath, 'db');
    await fs.writeFile(`${lbugPath}.wal`, 'partial wal');

    const health = await getIndexHealth(tmpRepo.dbPath);

    expect(health.ok).toBe(false);
    expect(health.reason).toBe('leftover-sidecar');
    expect(health.message).toContain('lbug.wal');
  });

  it('reports a missing LadybugDB file as unhealthy even when meta.json exists', async () => {
    const { storagePath } = getStoragePaths(tmpRepo.dbPath);
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({
        repoPath: tmpRepo.dbPath,
        lastCommit: 'abc',
        indexedAt: new Date().toISOString(),
      }),
    );

    const health = await getIndexHealth(tmpRepo.dbPath);

    expect(health.ok).toBe(false);
    expect(health.reason).toBe('missing-db');
    expect(health.message).toContain('LadybugDB index is missing');
  });

  it('reports an interrupted analyze marker as unhealthy', async () => {
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(lbugPath, 'db');
    await createAnalysisIncompleteMarker(storagePath, 'testing');

    const health = await getIndexHealth(tmpRepo.dbPath);

    expect(health.ok).toBe(false);
    expect(health.reason).toBe('incomplete-marker');
    expect(health.message).toContain('interrupted');
  });

  it('promotes a temporary LadybugDB file only after removing old final artifacts', async () => {
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    const tempPath = createTempLbugPath(storagePath, 'unit');
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(lbugPath, 'old-db');
    await fs.writeFile(`${lbugPath}.wal`, 'old-wal');
    await fs.writeFile(tempPath, 'new-db');

    await promoteLbugDatabase(tempPath, lbugPath);

    await expect(fs.readFile(lbugPath, 'utf-8')).resolves.toBe('new-db');
    await expect(fs.access(`${lbugPath}.wal`)).rejects.toThrow();
    await expect(fs.access(tempPath)).rejects.toThrow();
  });

  it('cleanupLbugArtifacts removes all known LadybugDB sidecars', async () => {
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    await fs.mkdir(storagePath, { recursive: true });
    for (const suffix of ['', '.wal', '.lock', '.shadow', '.wal.checkpoint']) {
      await fs.writeFile(`${lbugPath}${suffix}`, `artifact:${suffix}`);
    }

    await cleanupLbugArtifacts(lbugPath);

    for (const suffix of ['', '.wal', '.lock', '.shadow', '.wal.checkpoint']) {
      await expect(fs.access(`${lbugPath}${suffix}`)).rejects.toThrow();
    }
  });
});
