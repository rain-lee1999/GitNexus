import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CODEX_PLUGIN_ID,
  getCodexPluginMcpEntry,
  resolveCodexSetupPaths,
  type McpEntry,
  type SetupOptions,
} from './setup.js';

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 15_000;
const MCP_TIMEOUT_MS = 30_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_SKILLS = [
  'gitnexus-exploring',
  'gitnexus-debugging',
  'gitnexus-impact-analysis',
  'gitnexus-refactoring',
  'gitnexus-pr-review',
  'gitnexus-guide',
  'gitnexus-cli',
];

export interface CodexDoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface CodexDoctorReport {
  ok: boolean;
  checks: CodexDoctorCheck[];
}

interface CodexMcpRegistration {
  name?: string;
  enabled?: boolean;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
    cwd?: string | null;
  };
}

export interface CodexDoctorOptions extends SetupOptions {
  runProtocol?: boolean;
}

function commandOptions(cwd?: string) {
  return {
    encoding: 'utf-8' as const,
    shell: process.platform === 'win32',
    timeout: CHECK_TIMEOUT_MS,
    ...(cwd ? { cwd } : {}),
  };
}

function parseJsonOutput<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function runCodexJson<T>(
  codexBin: string,
  args: string[],
  label: string,
  cwd?: string,
): Promise<T> {
  const { stdout } = await execFileAsync(codexBin, args, commandOptions(cwd));
  return parseJsonOutput<T>(stdout, label);
}

function entryFromRegistration(registration: CodexMcpRegistration): McpEntry | null {
  const transport = registration.transport;
  if (!transport?.command || transport.type !== 'stdio') return null;
  return { command: transport.command, args: transport.args ?? [] };
}

async function checkMcpProtocol(
  entry: McpEntry,
): Promise<{ serverVersion: string; toolCount: number }> {
  const client = new Client({ name: 'gitnexus-doctor', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    stderr: 'pipe',
  });

  try {
    await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
    const server = client.getServerVersion();
    const tools = await client.listTools(undefined, { timeout: MCP_TIMEOUT_MS });
    if (!server?.name || !tools.tools.some((tool) => tool.name === 'list_repos')) {
      throw new Error('server initialized but required GitNexus tools were not listed');
    }
    return { serverVersion: `${server.name}@${server.version}`, toolCount: tools.tools.length };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function resolvePackagedMcpEntry(): Promise<McpEntry> {
  const compiledEntry = path.join(__dirname, 'index.js');
  if (await isFile(compiledEntry)) {
    return { command: process.execPath, args: [compiledEntry, 'mcp'] };
  }

  const sourceEntry = path.join(__dirname, 'index.ts');
  if (await isFile(sourceEntry)) {
    return { command: process.execPath, args: ['--import', 'tsx', sourceEntry, 'mcp'] };
  }

  throw new Error('GitNexus package CLI entry was not found');
}

export async function runCodexDoctor(options: CodexDoctorOptions = {}): Promise<CodexDoctorReport> {
  const paths = resolveCodexSetupPaths(options);
  const checks: CodexDoctorCheck[] = [];
  let codexBin = '';
  let registration: CodexMcpRegistration | null = null;
  let expectedPluginEntry: McpEntry | null = null;

  try {
    const { stdout } = await execFileAsync('codex', ['--version'], commandOptions());
    codexBin = 'codex';
    checks.push({ name: 'Codex CLI', status: 'pass', detail: stdout.trim() });
  } catch (error: any) {
    checks.push({
      name: 'Codex CLI',
      status: 'fail',
      detail: error.message,
      fix: 'Install or update Codex CLI, then run `gitnexus setup`.',
    });
  }

  if (await isFile(paths.configPath)) {
    checks.push({ name: 'Codex config', status: 'pass', detail: paths.configPath });
  } else {
    checks.push({
      name: 'Codex config',
      status: 'warn',
      detail: `No config file at ${paths.configPath}`,
      fix: `Run \`gitnexus setup --codex-scope ${paths.scope}${paths.projectRoot ? ` --project-root "${paths.projectRoot}"` : ''}\`.`,
    });
  }

  const missingSkills: string[] = [];
  for (const skill of REQUIRED_SKILLS) {
    if (!(await isFile(path.join(paths.skillsDir, skill, 'SKILL.md')))) missingSkills.push(skill);
  }
  checks.push(
    missingSkills.length === 0
      ? {
          name: 'Codex skills',
          status: 'pass',
          detail: `${REQUIRED_SKILLS.length} detailed skills in ${paths.skillsDir}`,
        }
      : {
          name: 'Codex skills',
          status: 'warn',
          detail: `Missing ${missingSkills.join(', ')} in ${paths.skillsDir}`,
          fix: `Run \`gitnexus setup --codex-scope ${paths.scope}${paths.projectRoot ? ` --project-root "${paths.projectRoot}"` : ''}\`.`,
        },
  );

  if (codexBin && paths.scope === 'user') {
    try {
      const plugins = await runCodexJson<{ installed?: Array<any> }>(
        codexBin,
        ['plugin', 'list', '--json'],
        'codex plugin list',
      );
      const plugin = plugins.installed?.find((candidate) => candidate.pluginId === CODEX_PLUGIN_ID);
      if (plugin?.installed && plugin?.enabled) {
        expectedPluginEntry = await getCodexPluginMcpEntry();
        checks.push({
          name: 'Codex plugin/hooks',
          status: 'pass',
          detail: `${CODEX_PLUGIN_ID} installed and enabled`,
        });
      } else {
        checks.push({
          name: 'Codex plugin/hooks',
          status: 'warn',
          detail: `${CODEX_PLUGIN_ID} is not installed and enabled`,
          fix: 'Run `gitnexus setup`; it registers the bundled marketplace and installs the plugin.',
        });
      }
    } catch (error: any) {
      checks.push({
        name: 'Codex plugin/hooks',
        status: 'warn',
        detail: `Plugin CLI unavailable: ${error.message}`,
        fix: 'Update Codex CLI for plugin/hooks support. Direct MCP and detailed skills can still work.',
      });
    }
  } else if (paths.scope === 'project') {
    checks.push({
      name: 'Codex plugin/hooks',
      status: 'warn',
      detail: 'Plugins are user-scoped; project setup does not install the GitNexus plugin hooks.',
      fix: 'Run `gitnexus setup --codex-scope user` to install the Codex plugin.',
    });
  } else {
    checks.push({
      name: 'Codex plugin/hooks',
      status: 'warn',
      detail: 'Codex CLI is unavailable, so plugin and hook state could not be inspected.',
      fix: 'Install or update Codex CLI, then run `gitnexus setup`.',
    });
  }

  if (codexBin) {
    try {
      registration = await runCodexJson<CodexMcpRegistration>(
        codexBin,
        ['mcp', 'get', 'gitnexus', '--json'],
        'codex mcp get',
        paths.projectRoot,
      );
      const entry = entryFromRegistration(registration);
      if (registration.enabled === false || !entry) {
        throw new Error('GitNexus MCP registration is disabled or not stdio');
      }
      const expected = expectedPluginEntry;
      if (
        expected &&
        (entry.command !== expected.command ||
          entry.args.length !== expected.args.length ||
          entry.args.some((arg, index) => arg !== expected.args[index]))
      ) {
        throw new Error(
          `GitNexus plugin MCP is shadowed or stale (expected ${expected.command} ${expected.args.join(' ')})`,
        );
      }
      checks.push({
        name: 'Codex MCP registration',
        status: 'pass',
        detail: `${entry.command} ${entry.args.join(' ')}`,
      });
    } catch (error: any) {
      checks.push({
        name: 'Codex MCP registration',
        status: 'fail',
        detail: error.message,
        fix: `Run \`gitnexus setup --codex-scope ${paths.scope}${paths.projectRoot ? ` --project-root "${paths.projectRoot}"` : ''}\`.`,
      });
    }
  } else {
    checks.push({
      name: 'Codex MCP registration',
      status: 'fail',
      detail: 'Codex CLI is unavailable, so the GitNexus MCP registration could not be inspected.',
      fix: 'Install or update Codex CLI, then run `gitnexus setup`.',
    });
  }

  if (options.runProtocol !== false) {
    try {
      // Exercise this installed package entry, not an npx fallback that could
      // reach the network or a stale global binary.
      const healthy = await checkMcpProtocol(await resolvePackagedMcpEntry());
      checks.push({
        name: 'Packaged MCP initialize/tools/list',
        status: 'pass',
        detail: `${healthy.serverVersion}, ${healthy.toolCount} tools`,
      });
    } catch (error: any) {
      checks.push({
        name: 'Packaged MCP initialize/tools/list',
        status: 'fail',
        detail: error.message,
        fix: 'Run `gitnexus setup`, then retry `gitnexus doctor codex`.',
      });
    }
  }

  return { ok: !checks.some((check) => check.status === 'fail'), checks };
}

export async function doctorCodexCommand(
  options: CodexDoctorOptions = {},
): Promise<CodexDoctorReport> {
  const report = await runCodexDoctor(options);
  const hasWarnings = report.checks.some((check) => check.status === 'warn');
  console.log('GitNexus Doctor — Codex\n');
  for (const check of report.checks) {
    const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${marker}] ${check.name}: ${check.detail}`);
    if (check.fix) console.log(`       Fix: ${check.fix}`);
  }
  console.log(
    `\nResult: ${report.ok ? (hasWarnings ? 'healthy with warnings' : 'healthy') : 'action required'}`,
  );
  if (!report.ok) process.exitCode = 1;
  return report;
}
