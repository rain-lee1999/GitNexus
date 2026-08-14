import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import { statusCommand } from '../../src/cli/status.js';
import { getStoragePaths, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

describe('statusCommand index health warnings', () => {
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let originalCwd: string;
  let logs: string[];

  beforeEach(async () => {
    tmpRepo = await createTempDir('gn-status-health-');
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

  it('recommends a smaller embedding-preserving analyze when a stale LadybugDB WAL remains next to an embedded index', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    const meta: RepoMeta = {
      repoPath: tmpRepo.dbPath,
      lastCommit: currentCommit,
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { files: 1, nodes: 2, edges: 3, embeddings: 42 },
    };
    await saveMeta(storagePath, meta);
    await fs.writeFile(lbugPath, 'db');
    await fs.writeFile(`${lbugPath}.wal`, 'partial wal');

    await statusCommand();

    const output = logs.join('\n');
    expect(output).toContain('Index health: ⚠️ incomplete or interrupted');
    expect(output).toContain('lbug.wal');
    expect(output).not.toContain('Status: ✅ up-to-date');
    expect(output).toContain('Run: gitnexus analyze --embeddings');
    expect(output).not.toContain('gitnexus agent-context plan');
    expect(output).toContain(
      'Fallback if analyze still fails: gitnexus clean --force && gitnexus analyze --embeddings',
    );
  });

  it('reports up-to-date when metadata is current and no LadybugDB sidecars remain', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();
    const { storagePath, lbugPath } = getStoragePaths(tmpRepo.dbPath);
    const meta: RepoMeta = {
      repoPath: tmpRepo.dbPath,
      lastCommit: currentCommit,
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { files: 1, nodes: 2, edges: 3 },
    };
    await saveMeta(storagePath, meta);
    await fs.writeFile(lbugPath, 'db');

    await statusCommand();

    const output = logs.join('\n');
    expect(output).toContain('Status: ✅ up-to-date');
    expect(output).not.toContain('Index health: ⚠️');
  });
});
