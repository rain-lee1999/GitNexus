import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { statusCommand } from '../../src/cli/status.js';
import { getStoragePaths, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const GITNEXUS_CONTEXT_VERSION_MARKER = '<!-- gitnexus:context-version:1 -->';

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

  async function writeManagedSkills(commit: string) {
    const skillsDir = path.join(tmpRepo.dbPath, '.agents', 'skills');
    const names = [
      'gitnexus-exploring',
      'gitnexus-debugging',
      'gitnexus-impact-analysis',
      'gitnexus-refactoring',
      'gitnexus-pr-review',
      'gitnexus-guide',
      'gitnexus-cli',
    ];
    for (const name of names) {
      const skillDir = path.join(skillsDir, name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\n`, 'utf-8');
    }
    await fs.writeFile(path.join(skillsDir, '.gitnexus-managed-commit'), `${commit}\n`, 'utf-8');
  }

  it('shows embeddings/vector/FTS capability state and no enrichment recommendation when already enriched', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();

    await writeManagedSkills(currentCommit);
    const generatedDir = path.join(tmpRepo.dbPath, '.agents', 'skills', 'gitnexus-generated-auth');
    await fs.mkdir(generatedDir, { recursive: true });
    await fs.writeFile(path.join(generatedDir, 'SKILL.md'), '# Auth\n', 'utf-8');
    await fs.writeFile(
      path.join(tmpRepo.dbPath, '.agents', 'skills', '.gitnexus-generated-commit'),
      `${currentCommit}\n`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpRepo.dbPath, 'AGENTS.md'),
      `<!-- gitnexus:start -->\n${GITNEXUS_CONTEXT_VERSION_MARKER}\nctx\n<!-- gitnexus:end -->\n`,
      'utf-8',
    );

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
    expect(output).toContain(
      'Agent helpers: AGENTS.md current, managed skills current, generated skills current',
    );
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
    expect(output).toContain(
      'Agent helpers: AGENTS.md missing, managed skills missing, generated skills not-generated',
    );
    expect(output).toContain('Recommendation: run gitnexus analyze --force --embeddings');
    expect(output).toContain('Recommendation: run gitnexus analyze --force --skills');
  });

  it('does not require a generated marker when no generated skills exist', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();

    await writeManagedSkills(currentCommit);
    await fs.writeFile(
      path.join(tmpRepo.dbPath, 'AGENTS.md'),
      `<!-- gitnexus:start -->\n${GITNEXUS_CONTEXT_VERSION_MARKER}\nctx\n<!-- gitnexus:end -->\n`,
      'utf-8',
    );
    await writeHealthyMeta({
      repoPath: tmpRepo.dbPath,
      lastCommit: currentCommit,
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { embeddings: 9 },
    });

    await statusCommand();

    const output = logs.join('\n');
    expect(output).toContain('generated skills not-generated');
    expect(output).not.toContain('Recommendation: run gitnexus analyze --force --skills');
  });

  it('reports legacy commit-based AGENTS.md context as stale for one-time migration', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();

    await writeManagedSkills(currentCommit);
    await fs.writeFile(
      path.join(tmpRepo.dbPath, 'AGENTS.md'),
      `<!-- gitnexus:start -->\n<!-- gitnexus:index-commit:${currentCommit} -->\nctx\n<!-- gitnexus:end -->\n`,
      'utf-8',
    );
    await writeHealthyMeta({
      repoPath: tmpRepo.dbPath,
      lastCommit: currentCommit,
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { embeddings: 9 },
    });

    await statusCommand();

    const output = logs.join('\n');
    expect(output).toContain('Agent helpers: AGENTS.md stale, managed skills current');
    expect(output).toContain('Recommendation: run gitnexus analyze --force --skills');
  });

  it('reports generated skills stale independently from current managed skills', async () => {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();

    await writeManagedSkills(currentCommit);
    const skillsDir = path.join(tmpRepo.dbPath, '.agents', 'skills');
    const generatedDir = path.join(skillsDir, 'gitnexus-generated-auth');
    await fs.mkdir(generatedDir, { recursive: true });
    await fs.writeFile(path.join(generatedDir, 'SKILL.md'), '# Auth\n', 'utf-8');
    await fs.writeFile(path.join(skillsDir, '.gitnexus-generated-commit'), 'old-commit\n', 'utf-8');
    await fs.writeFile(
      path.join(tmpRepo.dbPath, 'AGENTS.md'),
      `<!-- gitnexus:start -->\n${GITNEXUS_CONTEXT_VERSION_MARKER}\nctx\n<!-- gitnexus:end -->\n`,
      'utf-8',
    );
    await writeHealthyMeta({
      repoPath: tmpRepo.dbPath,
      lastCommit: currentCommit,
      indexedAt: '2026-05-04T00:00:00.000Z',
      stats: { embeddings: 9 },
    });

    await statusCommand();

    const output = logs.join('\n');
    expect(output).toContain(
      'Agent helpers: AGENTS.md current, managed skills current, generated skills stale',
    );
    expect(output).toContain('Recommendation: run gitnexus analyze --force --skills');
  });
});
