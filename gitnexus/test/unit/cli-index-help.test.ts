import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');

function runHelp(command: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, command, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('CLI help surface', () => {
  it('setup help exposes Codex user/project scope controls', () => {
    const result = runHelp('setup');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--codex-scope <scope>');
    expect(result.stdout).toContain('--project-root <path>');
  });

  it('doctor help exposes the Codex target and scope controls', () => {
    const result = runHelp('doctor');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('doctor [options] [target]');
    expect(result.stdout).toContain('--codex-scope <scope>');
    expect(result.stdout).toContain('--project-root <path>');
    expect(result.stdout).toContain('codex  Check Codex CLI');
  });

  it('forwards real Commander options in the correct order for project setup and doctor', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cli-codex-scope-'));
    const home = path.join(tempRoot, 'home');
    const projectRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      PATH: '',
    };

    try {
      const setup = runCli(
        ['setup', '--codex-scope', 'project', '--project-root', projectRoot],
        env,
      );
      expect(setup.status, setup.stderr).toBe(0);
      expect(fs.readFileSync(path.join(projectRoot, '.codex', 'config.toml'), 'utf8')).toContain(
        '[mcp_servers.gitnexus]',
      );
      expect(
        fs.existsSync(path.join(projectRoot, '.agents', 'skills', 'gitnexus-cli', 'SKILL.md')),
      ).toBe(true);

      const doctor = runCli(
        ['doctor', 'codex', '--codex-scope', 'project', '--project-root', projectRoot],
        env,
      );
      expect(doctor.status, doctor.stderr).toBe(1);
      expect(doctor.stdout).toContain('[FAIL] Codex CLI:');
      expect(doctor.stdout).toContain(
        `[PASS] Codex config: ${path.join(projectRoot, '.codex', 'config.toml')}`,
      );
      expect(doctor.stdout).toContain(
        `7 detailed skills in ${path.join(projectRoot, '.agents', 'skills')}`,
      );
      expect(doctor.stdout).toContain('Plugins are user-scoped');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('agent-context help exposes explicit read-only plan and write apply actions', () => {
    const result = runHelp('agent-context');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent-context [options] <action>');
    expect(result.stdout).toContain('--path <absolute-worktree>');
    expect(result.stdout).toContain('--json');
    expect(result.stdout).toContain('plan');
    expect(result.stdout).toContain('apply');
  });

  it('query help keeps advanced search options without importing analyze deps', () => {
    const result = runHelp('query');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--context <text>');
    expect(result.stdout).toContain('--goal <text>');
    expect(result.stdout).toContain('--content');
    expect(result.stderr).not.toContain('tree-sitter-kotlin');
  });

  it('context help keeps optional name and disambiguation flags', () => {
    const result = runHelp('context');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('context [options] [name]');
    expect(result.stdout).toContain('--uid <uid>');
    expect(result.stdout).toContain('--file <path>');
  });

  it('impact help keeps repo and include-tests flags', () => {
    const result = runHelp('impact');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--depth <n>');
    expect(result.stdout).toContain('--include-tests');
    expect(result.stdout).toContain('--repo <name>');
  });

  it('detect-changes help exposes compare scope and base-ref flags', () => {
    const result = runHelp('detect-changes');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gitnexus detect-changes|detect_changes [options]');
    expect(result.stdout).toContain('--scope <scope>');
    expect(result.stdout).toContain('--base-ref <ref>');
    expect(result.stdout).toContain('--repo <name>');
  });

  it('wiki help shows provider, review, and verbose flags', () => {
    const result = runHelp('wiki');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--provider <provider>');
    expect(result.stdout).toContain('--review');
    expect(result.stdout).toContain('-v, --verbose');
    expect(result.stdout).toContain('--model <model>');
    expect(result.stdout).toContain('--gist');
  });
});
