import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { generateAIContextFiles } from '../../src/cli/ai-context.js';

describe('generateAIContextFiles', () => {
  let tmpDir: string;
  let storagePath: string;
  const indexedCommit = '0123456789abcdef0123456789abcdef01234567';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-test-'));
    storagePath = path.join(tmpDir, '.gitnexus');
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ lastCommit: indexedCommit }),
      'utf-8',
    );
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('generates context files', async () => {
    const stats = {
      nodes: 100,
      edges: 200,
      processes: 10,
    };

    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    expect(result.files).toBeDefined();
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('creates or updates AGENTS.md with GitNexus section and no CLAUDE.md', async () => {
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('gitnexus:start');
    expect(content).toContain('gitnexus:end');
    expect(content).toContain('<!-- gitnexus:context-version:1 -->');
    expect(content).not.toContain('gitnexus:index-commit:');
    expect(content).toContain('TestProject');
    await expect(fs.access(path.join(tmpDir, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('keeps tracked AGENTS.md stable after committing it and refreshing the index', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-git-test-'));
    const repoStoragePath = path.join(repoPath, '.gitnexus');

    try {
      execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'GitNexus Test'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.email', 'gitnexus@test.invalid'], { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README.md'), '# Test\n', 'utf-8');
      execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'pipe' });

      const initialCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();
      await fs.mkdir(repoStoragePath, { recursive: true });
      await fs.writeFile(
        path.join(repoStoragePath, 'meta.json'),
        JSON.stringify({ lastCommit: initialCommit }),
        'utf-8',
      );
      await generateAIContextFiles(repoPath, repoStoragePath, 'StableProject', {
        nodes: 10,
        edges: 20,
        processes: 3,
      });

      execFileSync('git', ['add', '--force', 'AGENTS.md'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'add generated context'], {
        cwd: repoPath,
        stdio: 'pipe',
      });
      const refreshedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();
      await fs.writeFile(
        path.join(repoStoragePath, 'meta.json'),
        JSON.stringify({ lastCommit: refreshedCommit }),
        'utf-8',
      );

      const before = await fs.readFile(path.join(repoPath, 'AGENTS.md'), 'utf-8');
      await generateAIContextFiles(repoPath, repoStoragePath, 'StableProject', {
        nodes: 10,
        edges: 20,
        processes: 3,
      });
      const after = await fs.readFile(path.join(repoPath, 'AGENTS.md'), 'utf-8');
      const status = execFileSync('git', ['status', '--porcelain', '--', 'AGENTS.md'], {
        cwd: repoPath,
        encoding: 'utf-8',
      });

      expect(after).toBe(before);
      expect(status).toBe('');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('keeps the load-bearing repo-specific sections in the AGENTS.md block (#856)', async () => {
    // The trimmed block must still contain everything that is genuinely
    // unique per repo or load-bearing for the agent: the freshness warning,
    // the Always Do / Never Do imperative lists, the Resources URI table
    // (projectName-interpolated), and the skills routing table that tells
    // the agent which skill file to read for each task.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

    expect(content).toContain('Graph stale/missing');
    expect(content).toContain('gitnexus refresh ensure --path <absolute-worktree>');
    expect(content).toContain('detect_changes` is not freshness-gated');
    expect(content).toContain('## Always Do');
    expect(content).toContain('## Never Do');
    expect(content).toContain('## Resources');
    expect(content).toContain('gitnexus://repo/TestProject/context');
    expect(content).toContain('gitnexus-impact-analysis/SKILL.md');
    expect(content).toContain('gitnexus-refactoring/SKILL.md');
    expect(content).toContain('gitnexus-debugging/SKILL.md');
    expect(content).toContain('gitnexus-cli/SKILL.md');
  });

  it('routes generated skills to their direct Codex discovery paths', async () => {
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', { nodes: 5 }, [
      {
        name: 'gitnexus-generated-auth',
        label: 'Auth',
        symbolCount: 5,
        fileCount: 2,
      },
    ]);

    const content = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('.agents/skills/gitnexus-generated-auth/SKILL.md');
    expect(content).not.toContain('.claude/skills');
  });

  it('does not duplicate content that already lives in skill files (#856)', async () => {
    // The six sections listed in issue #856 are redundant with the skill
    // files routed from the AGENTS.md block. Their absence is the point of the
    // trim — assert each header is gone so a future regression that pads
    // the block back out fails here.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

    expect(content).not.toContain('## Tools Quick Reference');
    expect(content).not.toContain('## Impact Risk Levels');
    expect(content).not.toContain('## Self-Check Before Finishing');
    expect(content).not.toContain('## When Debugging');
    expect(content).not.toContain('## When Refactoring');
    expect(content).not.toContain('## Keeping the Index Fresh');
  });

  it('keeps the AGENTS.md GitNexus block under the token-cost budget (#856)', async () => {
    // The pre-trim block was ~5465 chars. After #856 it's ~2580 — about a
    // 52% reduction. 2700 is a soft ceiling that still leaves headroom for
    // legitimate future additions but will fail loudly if the trim is
    // reverted or someone pads the block back out toward the original size.
    const stats = { nodes: 50, edges: 100, processes: 5 };
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    const block = content.slice(
      content.indexOf('<!-- gitnexus:start -->'),
      content.indexOf('<!-- gitnexus:end -->'),
    );
    expect(block.length).toBeLessThan(2700);
  });

  it('handles empty stats', async () => {
    const stats = {};
    const result = await generateAIContextFiles(tmpDir, storagePath, 'EmptyProject', stats);
    expect(result.files).toBeDefined();
  });

  it('updates existing AGENTS.md without duplicating', async () => {
    const stats = { nodes: 10 };

    // Run twice
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);
    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    const content = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');

    // Should only have one gitnexus section
    const starts = (content.match(/gitnexus:start/g) || []).length;
    expect(starts).toBe(1);
  });

  it('installs skills files', async () => {
    const stats = { nodes: 10 };
    const result = await generateAIContextFiles(tmpDir, storagePath, 'TestProject', stats);

    // Should have installed skill files
    const skillsDir = path.join(tmpDir, '.agents', 'skills');
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'gitnexus-exploring',
        'gitnexus-debugging',
        'gitnexus-impact-analysis',
        'gitnexus-refactoring',
        'gitnexus-pr-review',
        'gitnexus-guide',
        'gitnexus-cli',
      ]),
    );
    expect(await fs.readFile(path.join(skillsDir, '.gitnexus-managed-commit'), 'utf-8')).toBe(
      `${indexedCommit}\n`,
    );
    await expect(fs.access(path.join(skillsDir, '.gitnexus-generated-commit'))).rejects.toThrow();
    expect(result.files).toContain('.agents/skills/ (7 GitNexus skills)');
    const cliSkill = await fs.readFile(path.join(skillsDir, 'gitnexus-cli', 'SKILL.md'), 'utf-8');
    expect(cliSkill).toContain('gitnexus doctor codex');
    expect(cliSkill).not.toMatch(/CLAUDE\.md|Claude Code|\.claude\/skills/);
    await expect(fs.access(path.join(tmpDir, '.claude'))).rejects.toThrow();
  });

  it('does not refresh the generated-skills marker during ordinary context generation', async () => {
    const markerPath = path.join(tmpDir, '.agents', 'skills', '.gitnexus-generated-commit');
    await fs.writeFile(markerPath, 'older-index-commit\n', 'utf-8');

    await generateAIContextFiles(tmpDir, storagePath, 'TestProject', { nodes: 10 });

    expect(await fs.readFile(markerPath, 'utf-8')).toBe('older-index-commit\n');
    expect(
      await fs.readFile(
        path.join(tmpDir, '.agents', 'skills', '.gitnexus-managed-commit'),
        'utf-8',
      ),
    ).toBe(`${indexedCommit}\n`);
  });

  it('preserves manual AGENTS.md and never touches CLAUDE.md when skipAgentsMd is enabled', async () => {
    const stats = { nodes: 42, edges: 84, processes: 3 };
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const claudePath = path.join(tmpDir, 'CLAUDE.md');
    const agentsContent = '# AGENTS\n\nCustom manual instructions only\n';
    const claudeContent = '# CLAUDE\n\nCustom manual instructions only\n';

    await fs.writeFile(agentsPath, agentsContent, 'utf-8');
    await fs.writeFile(claudePath, claudeContent, 'utf-8');

    const result = await generateAIContextFiles(
      tmpDir,
      storagePath,
      'TestProject',
      stats,
      undefined,
      { skipAgentsMd: true },
    );

    expect(result.files).toContain('AGENTS.md (skipped via --skip-agents-md)');
    expect(result.files.some((file) => file.startsWith('CLAUDE.md'))).toBe(false);

    const agentsAfter = await fs.readFile(agentsPath, 'utf-8');
    const claudeAfter = await fs.readFile(claudePath, 'utf-8');
    expect(agentsAfter).toBe(agentsContent);
    expect(claudeAfter).toBe(claudeContent);
  });

  it('preserves inline marker references in prose and does not corrupt markdown (#1041)', async () => {
    // Regression guard for #1041. Existing agent instructions may contain a
    // prose paragraph referencing the marker pair inline, wrapped in a
    // backtick-quoted fragment mid-sentence. `indexOf` (the pre-fix
    // matcher) would match both of those inline markers and replace the
    // content between them with the full injected block, destroying the
    // sentence and leaving the backtick unclosed.
    //
    // Per-test tmpdir so we start from a known clean slate — the shared
    // `tmpDir` from beforeAll may already contain AGENTS.md from earlier
    // tests in this describe block.
    const bugDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-1041-'));
    const bugStorage = path.join(bugDir, '.gitnexus');
    await fs.mkdir(bugStorage, { recursive: true });

    const inlineProseLine =
      'See the `<!-- gitnexus:start --> … <!-- gitnexus:end -->` block in **[AGENTS.md](AGENTS.md)** for the canonical MCP tools, impact analysis rules, and index instructions.';
    const originalContent = `# Agent Rules\n\nLast reviewed: 2026-04-21\n\n## GitNexus rules\n\n${inlineProseLine}\n`;

    const agentsMd = path.join(bugDir, 'AGENTS.md');
    await fs.writeFile(agentsMd, originalContent, 'utf-8');

    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };

      // First run — no section-position markers exist yet, so the
      // injector must append a fresh section at end. The inline prose
      // must be preserved verbatim; if it disappears or gets altered,
      // the bug has recurred.
      await generateAIContextFiles(bugDir, bugStorage, 'TestProject', stats);
      let contentAfter = await fs.readFile(agentsMd, 'utf-8');

      expect(contentAfter, 'inline prose line must survive the first run verbatim').toContain(
        inlineProseLine,
      );
      // Exactly 2 start markers total: 1 inline (in prose) + 1
      // section-position (appended by the injector). The pre-fix
      // behaviour would have only 1 — the inline pair having been
      // consumed as if they were section delimiters.
      expect((contentAfter.match(/<!-- gitnexus:start -->/g) || []).length).toBe(2);
      expect((contentAfter.match(/<!-- gitnexus:end -->/g) || []).length).toBe(2);

      // Second run — the section from run 1 is now at section position,
      // so the injector must UPDATE in place (not re-append). Inline
      // prose stays preserved; marker counts unchanged.
      await generateAIContextFiles(bugDir, bugStorage, 'TestProject', stats);
      contentAfter = await fs.readFile(agentsMd, 'utf-8');

      expect(contentAfter, 'inline prose line must survive the second run verbatim').toContain(
        inlineProseLine,
      );
      expect((contentAfter.match(/<!-- gitnexus:start -->/g) || []).length).toBe(2);
      expect((contentAfter.match(/<!-- gitnexus:end -->/g) || []).length).toBe(2);
    } finally {
      await fs.rm(bugDir, { recursive: true, force: true });
    }
  });

  it('matches section markers on files with CRLF line endings (#1041 cross-platform)', async () => {
    // Locks in the CRLF leg of the section-position matcher. Git on
    // Windows may store files with `\r\n` line endings depending on
    // `core.autocrlf`; when a section line ends `<!-- gitnexus:start
    // -->\r\n`, the byte at `endPos` is `\r` (not `\n`). A `\n`-only
    // line-end check would reject the real section, fall through to
    // "append", and duplicate the block every run.
    const crlfDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-ai-ctx-crlf-'));
    const crlfStorage = path.join(crlfDir, '.gitnexus');
    await fs.mkdir(crlfStorage, { recursive: true });

    // Inline reference carries BOTH markers in a backtick-quoted
    // fragment — matches the shape of the inline reference that triggered
    // #1041, so the regression guard is meaningful.
    const inlineProseLine =
      'See the `<!-- gitnexus:start --> … <!-- gitnexus:end -->` block in **[AGENTS.md](AGENTS.md)** for more.';
    const seeded = [
      '# Agent Rules',
      '',
      '## GitNexus rules',
      '',
      inlineProseLine,
      '',
      '<!-- gitnexus:start -->',
      '# GitNexus — Code Intelligence (stale stub)',
      '<!-- gitnexus:end -->',
      '',
    ].join('\r\n');

    const agentsMd = path.join(crlfDir, 'AGENTS.md');
    await fs.writeFile(agentsMd, seeded, 'utf-8');

    try {
      const stats = { nodes: 50, edges: 100, processes: 5 };
      await generateAIContextFiles(crlfDir, crlfStorage, 'TestProject', stats);
      const content = await fs.readFile(agentsMd, 'utf-8');

      // Inline prose survives verbatim — no corruption of CRLF bytes.
      expect(content).toContain(inlineProseLine);
      // Exactly 2 start markers total (1 inline + 1 section-position).
      // If CRLF handling broke, the inline marker would be (incorrectly)
      // matched as a section start, OR the real section would be
      // appended duplicated — either way we'd see !== 2.
      expect((content.match(/<!-- gitnexus:start -->/g) || []).length).toBe(2);
      expect((content.match(/<!-- gitnexus:end -->/g) || []).length).toBe(2);
      // Stale stub content must be gone — proves the section was
      // REPLACED (not appended as a duplicate), which requires the
      // CRLF-ending markers to have been matched.
      expect(content).not.toContain('# GitNexus — Code Intelligence (stale stub)');
    } finally {
      await fs.rm(crlfDir, { recursive: true, force: true });
    }
  });
});
