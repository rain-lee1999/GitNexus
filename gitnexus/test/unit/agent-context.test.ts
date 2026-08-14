import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { planAIContextFiles } from '../../src/cli/agent-context-plan.js';
import {
  AgentContextConflictError,
  applyAIContextPlan,
} from '../../src/cli/agent-context-apply.js';
import { agentContextCommand } from '../../src/cli/agent-context.js';

const tempDirs: string[] = [];

async function createRepoFixture(commit = '1111111111111111111111111111111111111111') {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-agent-context-'));
  tempDirs.push(repoPath);
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(
    path.join(storagePath, 'meta.json'),
    JSON.stringify({
      repoPath,
      lastCommit: commit,
      indexedAt: '2026-08-14T00:00:00.000Z',
      stats: { files: 12, nodes: 123, edges: 456, processes: 7 },
    }),
    'utf-8',
  );
  return { repoPath, storagePath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('agent context plan/apply boundary', () => {
  it('plans every declared asset without writing repository files', async () => {
    const { repoPath, storagePath } = await createRepoFixture();

    const plan = await planAIContextFiles(repoPath, storagePath, 'StableProject', {
      files: 12,
      nodes: 123,
      edges: 456,
      processes: 7,
    });

    expect(plan.repoPath).toBe(await fs.realpath(repoPath));
    expect(plan.planId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.changes.filter((change) => change.action === 'create')).toHaveLength(9);
    expect(plan.changes.map((change) => change.relativePath)).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        '.agents/skills/.gitnexus-managed-commit',
        '.agents/skills/gitnexus-cli/SKILL.md',
        '.agents/skills/gitnexus-guide/SKILL.md',
      ]),
    );

    const agents = plan.changes.find((change) => change.relativePath === 'AGENTS.md');
    expect(agents?.after).toContain('indexed by GitNexus as **StableProject**');
    expect(agents?.after).not.toContain('123 symbols');
    expect(agents?.after).not.toContain('456 relationships');
    expect(agents?.after).not.toContain('7 execution flows');
    expect(agents?.diff).toContain('+++ b/AGENTS.md');

    await expect(fs.access(path.join(repoPath, 'AGENTS.md'))).rejects.toThrow();
    await expect(fs.access(path.join(repoPath, '.agents'))).rejects.toThrow();
  });

  it('applies a reviewed plan idempotently', async () => {
    const { repoPath, storagePath } = await createRepoFixture();
    const plan = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});

    const first = await applyAIContextPlan(plan);
    expect(first.written).toHaveLength(9);
    expect(first.unchanged).toHaveLength(0);

    const secondPlan = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});
    expect(secondPlan.changes.every((change) => change.action === 'unchanged')).toBe(true);

    const second = await applyAIContextPlan(secondPlan);
    expect(second.written).toHaveLength(0);
    expect(second.unchanged).toHaveLength(9);
  });

  it('fails closed when a file changes after planning and writes no other targets', async () => {
    const { repoPath, storagePath } = await createRepoFixture();
    const plan = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});
    const manual = '# Manual instructions added after plan\n';
    await fs.writeFile(path.join(repoPath, 'AGENTS.md'), manual, 'utf-8');

    await expect(applyAIContextPlan(plan)).rejects.toBeInstanceOf(AgentContextConflictError);
    await expect(fs.readFile(path.join(repoPath, 'AGENTS.md'), 'utf-8')).resolves.toBe(manual);
    await expect(fs.access(path.join(repoPath, '.agents'))).rejects.toThrow();
  });

  it('fails closed on a malformed managed AGENTS.md block', async () => {
    const { repoPath, storagePath } = await createRepoFixture();
    const malformed = '# Rules\n\n<!-- gitnexus:start -->\nmissing end marker\n';
    await fs.writeFile(path.join(repoPath, 'AGENTS.md'), malformed, 'utf-8');

    await expect(planAIContextFiles(repoPath, storagePath, 'StableProject', {})).rejects.toThrow(
      /malformed GitNexus section/i,
    );
    expect(await fs.readFile(path.join(repoPath, 'AGENTS.md'), 'utf-8')).toBe(malformed);
    await expect(fs.access(path.join(repoPath, '.agents'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects symlinked output ancestors instead of escaping the repository', async () => {
    const { repoPath, storagePath } = await createRepoFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-agent-context-outside-'));
    tempDirs.push(outside);
    await fs.symlink(outside, path.join(repoPath, '.agents'));

    await expect(planAIContextFiles(repoPath, storagePath, 'StableProject', {})).rejects.toThrow(
      /symbolic link/i,
    );
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it('preserves routes for existing repo-specific generated skills', async () => {
    const { repoPath, storagePath } = await createRepoFixture();
    const generatedDir = path.join(repoPath, '.agents', 'skills', 'gitnexus-generated-auth-flow');
    await fs.mkdir(generatedDir, { recursive: true });
    await fs.writeFile(
      path.join(generatedDir, 'SKILL.md'),
      '---\nname: gitnexus-generated-auth-flow\n---\n\n# Auth Flow\n\n**12 symbols** across **4 files**\n',
      'utf-8',
    );

    const plan = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});
    const agents = plan.changes.find((change) => change.relativePath === 'AGENTS.md');
    expect(agents?.after).toContain('Work in the Auth Flow area');
    expect(agents?.after).toContain('.agents/skills/gitnexus-generated-auth-flow/SKILL.md');
  });

  it('rejects tampered or forged plans before any write', async () => {
    const { repoPath, storagePath } = await createRepoFixture();
    const tampered = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});
    tampered.changes[0].after += 'tampered\n';
    await expect(applyAIContextPlan(tampered)).rejects.toThrow(/plan content was modified/i);
    await expect(fs.access(path.join(repoPath, 'AGENTS.md'))).rejects.toThrow();

    const issued = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});
    const forged = { ...issued, changes: [...issued.changes] };
    await expect(applyAIContextPlan(forged)).rejects.toThrow(/plan issued by planAIContextFiles/i);
    await expect(fs.access(path.join(repoPath, 'AGENTS.md'))).rejects.toThrow();
  });

  it('requires a reviewed plan id for CLI apply and rejects marker injection', async () => {
    await expect(agentContextCommand('apply', {})).rejects.toThrow(/requires --expect/i);
    const { repoPath, storagePath } = await createRepoFixture();
    await expect(
      planAIContextFiles(
        repoPath,
        storagePath,
        'Safe\n<!-- gitnexus:end -->\n<!-- gitnexus:start -->',
        {},
      ),
    ).rejects.toThrow(/unsafe control or marker/i);
  });

  it('keeps the managed-skill fingerprint stable across indexed source commits', async () => {
    const firstCommit = '1111111111111111111111111111111111111111';
    const secondCommit = '2222222222222222222222222222222222222222';
    const { repoPath, storagePath } = await createRepoFixture(firstCommit);

    const firstPlan = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});
    const markerPath = '.agents/skills/.gitnexus-managed-commit';
    const firstMarker = firstPlan.changes.find(
      (change) => change.relativePath === markerPath,
    )?.after;

    await fs.writeFile(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ repoPath, lastCommit: secondCommit, indexedAt: '2026-08-14T01:00:00.000Z' }),
      'utf-8',
    );
    const secondPlan = await planAIContextFiles(repoPath, storagePath, 'StableProject', {});
    const secondMarker = secondPlan.changes.find(
      (change) => change.relativePath === markerPath,
    )?.after;

    expect(firstMarker).toMatch(/^sha256:[a-f0-9]{64}\n$/);
    expect(secondMarker).toBe(firstMarker);
  });
});
