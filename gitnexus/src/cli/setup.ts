/**
 * Setup Command
 *
 * One-time MCP configuration writer (global by default, project-scoped for Codex on request).
 * Detects installed AI editors and writes the appropriate MCP config
 * so the GitNexus MCP server is available in all projects.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { glob } from 'glob';
import { parseTree, modify, applyEdits, ParseError, parse as parseJsonc } from 'jsonc-parser';
import { getGlobalDir } from '../storage/repo-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const packageVersion: string = require('../../package.json').version;
const execFileAsync = promisify(execFile);
const EXTERNAL_COMMAND_TIMEOUT_MS = 60_000;
export const CODEX_PLUGIN_ID = 'gitnexus@gitnexus';

export type CodexScope = 'user' | 'project';

export interface SetupOptions {
  codexScope?: string;
  projectRoot?: string;
}

export interface McpEntry {
  command: string;
  args: string[];
}

export interface CodexSetupPaths {
  scope: CodexScope;
  codexHome: string;
  configPath: string;
  skillsDir: string;
  projectRoot?: string;
}

async function execFileWithInput(
  command: string,
  args: string[],
  options: { input?: string; shell?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: options.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs ?? EXTERNAL_COMMAND_TIMEOUT_MS;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const suffix = stderr.trim() || stdout.trim() || signal || `exit code ${code}`;
      reject(new Error(suffix));
    });

    child.stdin?.end(options.input ?? '');
  });
}

export interface SetupResult {
  configured: string[];
  skipped: string[];
  warnings: string[];
  errors: string[];
}

function getUserHome(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(getUserHome(), '.codex');
}

export function resolveCodexSetupPaths(options: SetupOptions = {}): CodexSetupPaths {
  const scope = options.codexScope ?? 'user';
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`Invalid Codex scope "${scope}". Expected "user" or "project".`);
  }

  const codexHome = getCodexHome();
  if (scope === 'project') {
    const projectRoot = path.resolve(options.projectRoot || process.cwd());
    return {
      scope,
      codexHome,
      projectRoot,
      configPath: path.join(projectRoot, '.codex', 'config.toml'),
      skillsDir: path.join(projectRoot, '.agents', 'skills'),
    };
  }

  return {
    scope,
    codexHome,
    configPath: path.join(codexHome, 'config.toml'),
    skillsDir: path.join(getUserHome(), '.agents', 'skills'),
  };
}

/**
 * Resolve the absolute path to the `gitnexus` binary if it's installed
 * globally (or via npm -g / yarn global). Returns null when not found.
 */
function resolveCommandBin(commandName: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const resolved = execFileSync(cmd, [commandName], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')[0]
      .trim();
    return resolved || null;
  } catch {
    return null;
  }
}

function resolveGitnexusBin(): string | null {
  const resolved = resolveCommandBin('gitnexus');
  if (!resolved) return null;

  // `npx gitnexus setup` injects an ephemeral `_npx/.../node_modules/.bin`
  // directory into PATH. Persisting that path works only until npm cleans its
  // cache. Project-local bins and system temp paths have the same problem.
  const normalized = resolved.replace(/\\/g, '/');
  const normalizedLower = normalized.toLowerCase();
  const tempRoot = path.resolve(os.tmpdir()).replace(/\\/g, '/').toLowerCase();
  const isAbsolute = path.isAbsolute(resolved) || /^[a-z]:\//i.test(normalized);
  const isEphemeral =
    normalizedLower.includes('/_npx/') ||
    normalizedLower.includes('/node_modules/.bin/') ||
    normalizedLower === tempRoot ||
    normalizedLower.startsWith(`${tempRoot}/`);

  return isAbsolute && !isEphemeral ? resolved : null;
}

/**
 * The MCP server entry for all editors.
 *
 * Prefers the globally-installed `gitnexus` binary (starts in ~1 s) over
 * a version-pinned `npx -y gitnexus@<current>` (cold-cache install of native deps can take
 * >60 s, exceeding Claude Code's 30 s MCP connection timeout).
 *
 * Falls back to npx when the binary isn't on PATH — e.g. first-time
 * users who ran `npx gitnexus analyze` but haven't done `npm i -g`.
 */
export function getMcpEntry(): McpEntry {
  const bin = resolveGitnexusBin();

  if (bin) {
    return { command: bin, args: ['mcp'] };
  }

  // Fallback: npx (works without a global install, but slow cold-start)
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', `gitnexus@${packageVersion}`, 'mcp'],
    };
  }
  return {
    command: 'npx',
    args: ['-y', `gitnexus@${packageVersion}`, 'mcp'],
  };
}

/**
 * OpenCode uses a different MCP format: { type: "local", command: [...] }
 * where command is a flat array (command + args combined).
 */
function getOpenCodeMcpEntry() {
  const bin = resolveGitnexusBin();

  if (bin) {
    return { type: 'local', command: [bin, 'mcp'] };
  }

  if (process.platform === 'win32') {
    return {
      type: 'local',
      command: ['cmd', '/c', 'npx', '-y', `gitnexus@${packageVersion}`, 'mcp'],
    };
  }
  return { type: 'local', command: ['npx', '-y', `gitnexus@${packageVersion}`, 'mcp'] };
}

/**
 * Detect indentation style from file content.
 * Returns formatting options matching the file's existing style.
 */
function detectIndentation(raw: string): { tabSize: number; insertSpaces: boolean } {
  const firstIndented = raw.match(/^( +|\t)/m);
  if (!firstIndented) return { tabSize: 2, insertSpaces: true };
  if (firstIndented[1] === '\t') return { tabSize: 1, insertSpaces: false };
  return { tabSize: firstIndented[1].length, insertSpaces: true };
}

/**
 * Merge a key/value pair into a JSONC config file, preserving comments and formatting.
 * If the file is genuinely corrupt (not valid JSONC), leaves it untouched.
 */
async function mergeJsoncFile(
  filePath: string,
  keyPath: string[],
  value: unknown,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    raw = '';
  }

  if (raw.trim().length === 0) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const formattingOptions = { tabSize: 2, insertSpaces: true };
    const edits = modify('{}', keyPath, value, { formattingOptions });
    const result = applyEdits('{}', edits);
    await fs.writeFile(filePath, result, 'utf-8');
    return true;
  }

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors);

  if (tree && tree.type === 'object' && parseErrors.length === 0) {
    const formattingOptions = detectIndentation(raw);
    const edits = modify(raw, keyPath, value, { formattingOptions });
    const result = applyEdits(raw, edits);
    await fs.writeFile(filePath, result, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Check if a directory exists
 */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

// ─── Editor-specific setup ─────────────────────────────────────────

async function setupCursor(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) {
    result.skipped.push('Cursor (not installed)');
    return;
  }

  const mcpPath = path.join(cursorDir, 'mcp.json');
  try {
    const ok = await mergeJsoncFile(mcpPath, ['mcpServers', 'gitnexus'], getMcpEntry());
    if (ok) {
      result.configured.push('Cursor');
    } else {
      result.errors.push('Cursor: mcp.json is corrupt — skipping to preserve existing content');
    }
  } catch (err: any) {
    result.errors.push(`Cursor: ${err.message}`);
  }
}

async function setupClaudeCode(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) {
    result.skipped.push('Claude Code (not installed)');
    return;
  }

  // Claude Code stores MCP config in ~/.claude.json
  const mcpPath = path.join(os.homedir(), '.claude.json');
  try {
    const ok = await mergeJsoncFile(mcpPath, ['mcpServers', 'gitnexus'], getMcpEntry());
    if (ok) {
      result.configured.push('Claude Code');
    } else {
      result.errors.push(
        'Claude Code: .claude.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Claude Code: ${err.message}`);
  }
}

/**
 * Install GitNexus skills to ~/.claude/skills/ for Claude Code.
 */
async function installClaudeCodeSkills(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const skillsDir = path.join(claudeDir, 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.installed.length > 0) {
      result.configured.push(
        `Claude Code skills (${installed.installed.length} skills → ~/.claude/skills/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`Claude Code skills: ${err.message}`);
  }
}

/**
 * Check whether an event array already contains a gitnexus-hook entry.
 */
function hasGitnexusHook(hooksObj: any, eventName: string): boolean {
  const entries = hooksObj?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (h: any) =>
      Array.isArray(h.hooks) &&
      h.hooks.some(
        (hh: any) => typeof hh.command === 'string' && hh.command.includes('gitnexus-hook'),
      ),
  );
}

/**
 * Merge hook entries into a JSONC settings file, preserving comments and formatting.
 * Uses chained modify()+applyEdits() calls to append to arrays without a full
 * JSON.stringify roundtrip that would strip comments.
 */
async function mergeHooksJsonc(
  filePath: string,
  entries: Array<{ eventName: string; value: unknown }>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    raw = '';
  }

  if (raw.trim().length === 0) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const hooks: any = {};
    for (const { eventName, value } of entries) {
      hooks[eventName] = [value];
    }
    const formattingOptions = { tabSize: 2, insertSpaces: true };
    const edits = modify('{}', ['hooks'], hooks, { formattingOptions });
    await fs.writeFile(filePath, applyEdits('{}', edits), 'utf-8');
    return true;
  }

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors);

  if (!tree || tree.type !== 'object' || parseErrors.length > 0) {
    return false;
  }

  const formattingOptions = detectIndentation(raw);
  let current = raw;

  for (const { eventName, value } of entries) {
    // Re-parse after each edit to get a fresh insertion index.
    const currentTree = parseTree(current, []);
    const hooksNode = currentTree?.children?.find(
      (c) => c.type === 'property' && c.children?.[0]?.value === 'hooks',
    );
    const eventNode = hooksNode?.children?.[1]?.children?.find(
      (c: any) => c.type === 'property' && c.children?.[0]?.value === eventName,
    );

    let insertIndex: number;
    if (eventNode?.children?.[1] && Array.isArray(eventNode.children[1].children)) {
      insertIndex = eventNode.children[1].children.length;
    } else {
      insertIndex = 0;
    }

    const edits = modify(current, ['hooks', eventName, insertIndex], value, {
      formattingOptions,
    });
    current = applyEdits(current, edits);
  }

  await fs.writeFile(filePath, current, 'utf-8');
  return true;
}

/**
 * Install GitNexus hooks to ~/.claude/settings.json for Claude Code.
 * Merges hook config without overwriting existing hooks, preserving
 * comments and formatting in the JSONC file.
 */
async function installClaudeCodeHooks(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const settingsPath = path.join(claudeDir, 'settings.json');

  // Source hooks bundled within the gitnexus package (hooks/claude/)
  const pluginHooksPath = path.join(__dirname, '..', '..', 'hooks', 'claude');

  // Copy unified hook script to ~/.claude/hooks/gitnexus/
  const destHooksDir = path.join(claudeDir, 'hooks', 'gitnexus');

  try {
    await fs.mkdir(destHooksDir, { recursive: true });

    const src = path.join(pluginHooksPath, 'gitnexus-hook.cjs');
    const dest = path.join(destHooksDir, 'gitnexus-hook.cjs');
    try {
      let content = await fs.readFile(src, 'utf-8');
      const resolvedCli = path.join(__dirname, '..', 'cli', 'index.js');
      const normalizedCli = path.resolve(resolvedCli).replace(/\\/g, '/');
      const jsonCli = JSON.stringify(normalizedCli);
      content = content.replace(
        "let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');",
        `let cliPath = ${jsonCli};`,
      );
      await fs.writeFile(dest, content, 'utf-8');
    } catch {
      // Script not found in source — skip
    }

    const hookPath = path.join(destHooksDir, 'gitnexus-hook.cjs').replace(/\\/g, '/');
    const hookCmd = `node "${hookPath.replace(/"/g, '\\"')}"`;

    // Check which hook events need entries (idempotent: skip if already registered)
    const parsed = await (async () => {
      try {
        const r = await fs.readFile(settingsPath, 'utf-8');
        return parseJsonc(r);
      } catch {
        return null;
      }
    })();

    const hookEntries: Array<{ eventName: string; value: unknown }> = [];

    // NOTE: SessionStart hooks are broken on Windows (Claude Code bug #23576).
    // Session context is delivered via CLAUDE.md / skills instead.

    if (!hasGitnexusHook(parsed?.hooks, 'PreToolUse')) {
      hookEntries.push({
        eventName: 'PreToolUse',
        value: {
          matcher: 'Grep|Glob|Bash',
          hooks: [
            {
              type: 'command',
              command: hookCmd,
              timeout: 10,
              statusMessage: 'Enriching with GitNexus graph context...',
            },
          ],
        },
      });
    }
    if (!hasGitnexusHook(parsed?.hooks, 'PostToolUse')) {
      hookEntries.push({
        eventName: 'PostToolUse',
        value: {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: hookCmd,
              timeout: 10,
              statusMessage: 'Checking GitNexus index freshness...',
            },
          ],
        },
      });
    }

    if (hookEntries.length === 0) {
      result.configured.push('Claude Code hooks (already configured)');
      return;
    }

    const ok = await mergeHooksJsonc(settingsPath, hookEntries);
    if (ok) {
      result.configured.push('Claude Code hooks (PreToolUse, PostToolUse)');
    } else {
      result.errors.push(
        'Claude Code hooks: settings.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Claude Code hooks: ${err.message}`);
  }
}

async function setupOpenCode(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) {
    result.skipped.push('OpenCode (not installed)');
    return;
  }

  const configPath = path.join(opencodeDir, 'opencode.json');
  try {
    const ok = await mergeJsoncFile(configPath, ['mcp', 'gitnexus'], getOpenCodeMcpEntry());
    if (ok) {
      result.configured.push('OpenCode');
    } else {
      result.errors.push(
        'OpenCode: opencode.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`OpenCode: ${err.message}`);
  }
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlArray(values: string[]): string {
  return `[${values.map(quoteTomlString).join(', ')}]`;
}

interface TomlSectionRange {
  start: number;
  end: number;
  bodyStart: number;
}

function findTomlSection(raw: string, sectionName: string): TomlSectionRange | null {
  const lines = raw.split(/(?<=\n)/);
  let offset = 0;
  let start = -1;
  let bodyStart = -1;

  for (const line of lines) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?(?:\r?\n)?$/);
    if (header) {
      if (start !== -1) return { start, end: offset, bodyStart };
      const currentName = header[1].trim();
      const isTarget =
        currentName === sectionName ||
        currentName === 'mcp_servers."gitnexus"' ||
        currentName === "mcp_servers.'gitnexus'";
      if (isTarget) {
        start = offset;
        bodyStart = offset + line.length;
      }
    }
    offset += line.length;
  }

  return start === -1 ? null : { start, end: raw.length, bodyStart };
}

function upsertTomlKey(sectionBody: string, key: string, formattedValue: string): string {
  const pattern = new RegExp(`^(\\s*)${key}\\s*=.*$`, 'm');
  const replacement = `$1${key} = ${formattedValue}`;
  if (pattern.test(sectionBody)) return sectionBody.replace(pattern, replacement);

  const newline = sectionBody.length === 0 || sectionBody.endsWith('\n') ? '' : '\n';
  return `${sectionBody}${newline}${key} = ${formattedValue}\n`;
}

/**
 * Update only command/args in the GitNexus TOML table. Other fields and tables
 * are preserved byte-for-byte so user policy such as enabled_tools survives.
 */
export async function upsertCodexConfigToml(
  configPath: string,
  entry: McpEntry = getMcpEntry(),
): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch {
    existing = '';
  }

  const sectionName = 'mcp_servers.gitnexus';
  const range = findTomlSection(existing, sectionName);
  const command = quoteTomlString(entry.command);
  const args = formatTomlArray(entry.args);
  let nextContent: string;

  if (range) {
    const prefix = existing.slice(0, range.bodyStart);
    const suffix = existing.slice(range.end);
    let body = existing.slice(range.bodyStart, range.end);
    body = upsertTomlKey(body, 'command', command);
    body = upsertTomlKey(body, 'args', args);
    nextContent = `${prefix}${body}${suffix}`;
  } else {
    const section = `[${sectionName}]\ncommand = ${command}\nargs = ${args}\n`;
    nextContent = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${section}` : section;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${nextContent.trimEnd()}\n`, 'utf-8');
}

/** Remove a legacy user-level GitNexus MCP table after the Codex plugin is installed. */
export async function removeCodexMcpConfigToml(configPath: string): Promise<boolean> {
  let existing: string;
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch {
    return false;
  }

  const range = findTomlSection(existing, 'mcp_servers.gitnexus');
  if (!range) return false;

  const nextContent = `${existing.slice(0, range.start)}${existing.slice(range.end)}`;
  await fs.writeFile(
    configPath,
    nextContent.trim().length > 0 ? `${nextContent.trimEnd()}\n` : '',
    'utf-8',
  );
  return true;
}

export function getCodexPluginBundlePath(): string {
  return path.resolve(__dirname, '..', '..', 'codex-plugin');
}

async function codexPluginBundleExists(): Promise<boolean> {
  const bundle = getCodexPluginBundlePath();
  return (
    (await fileExists(path.join(bundle, '.agents', 'plugins', 'marketplace.json'))) &&
    (await fileExists(path.join(bundle, '.codex-plugin', 'plugin.json')))
  );
}

async function configureCodexPlugin(codexBin: string): Promise<void> {
  if (!(await codexPluginBundleExists())) {
    throw new Error('bundled Codex plugin marketplace is missing');
  }

  const commandOptions = {
    shell: process.platform === 'win32',
    timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
  };
  const bundlePath = await fs.realpath(getCodexPluginBundlePath());
  const { stdout } = await execFileAsync(
    codexBin,
    ['plugin', 'marketplace', 'list', '--json'],
    commandOptions,
  );
  const listed = JSON.parse(stdout);
  const existing = listed?.marketplaces?.find(
    (marketplace: any) => marketplace?.name === 'gitnexus',
  );
  if (existing) {
    const configuredSource = existing?.marketplaceSource?.source ?? existing?.root;
    let configuredPath = configuredSource ? path.resolve(configuredSource) : '';
    if (configuredPath) {
      try {
        configuredPath = await fs.realpath(configuredPath);
      } catch {
        // An old npm cache path may already be gone; its resolved spelling is
        // still sufficient to distinguish it from the current bundle.
      }
    }
    if (existing?.marketplaceSource?.sourceType !== 'local' || configuredPath !== bundlePath) {
      await execFileAsync(
        codexBin,
        ['plugin', 'marketplace', 'remove', 'gitnexus', '--json'],
        commandOptions,
      );
    }
  }
  await execFileAsync(
    codexBin,
    ['plugin', 'marketplace', 'add', bundlePath, '--json'],
    commandOptions,
  );
  await execFileAsync(codexBin, ['plugin', 'add', CODEX_PLUGIN_ID, '--json'], commandOptions);
}

export async function getCodexPluginMcpEntry(): Promise<McpEntry> {
  const manifestPath = path.join(getCodexPluginBundlePath(), '.mcp.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  const entry = manifest?.gitnexus;
  if (typeof entry?.command !== 'string' || !Array.isArray(entry?.args)) {
    throw new Error('bundled Codex plugin has an invalid .mcp.json entry');
  }
  return { command: entry.command, args: entry.args };
}

async function verifyCodexMcpRegistration(
  codexBin: string,
  expected: McpEntry,
  cwd?: string,
): Promise<void> {
  const { stdout } = await execFileAsync(codexBin, ['mcp', 'get', 'gitnexus', '--json'], {
    shell: process.platform === 'win32',
    timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
    ...(cwd ? { cwd } : {}),
  });
  const parsed = JSON.parse(stdout);
  const actualArgs = parsed?.transport?.args;
  const matchesExpected =
    parsed?.transport?.command === expected.command &&
    Array.isArray(actualArgs) &&
    actualArgs.length === expected.args.length &&
    actualArgs.every((arg: string, index: number) => arg === expected.args[index]);
  if (
    parsed?.name !== 'gitnexus' ||
    parsed?.enabled === false ||
    parsed?.transport?.type !== 'stdio' ||
    !matchesExpected
  ) {
    throw new Error('codex mcp get returned an invalid or disabled GitNexus registration');
  }
}

async function setupCodex(result: SetupResult, paths: CodexSetupPaths): Promise<void> {
  const codexBin = resolveCommandBin('codex');
  const entry = getMcpEntry();

  if (codexBin) {
    try {
      // Codex rejects a configured CODEX_HOME when the directory itself does
      // not exist, even for read-only commands such as plugin marketplace list.
      await fs.mkdir(paths.codexHome, { recursive: true });
    } catch (err: any) {
      result.errors.push(`Codex: cannot create ${paths.codexHome} (${err.message})`);
      return;
    }
  }

  if (codexBin && paths.scope === 'user') {
    try {
      await configureCodexPlugin(codexBin);
      // A legacy user table shadows plugin-provided MCP servers with the same
      // name. Remove that exact table so the plugin is the single source.
      await removeCodexMcpConfigToml(paths.configPath);
      await verifyCodexMcpRegistration(codexBin, await getCodexPluginMcpEntry());
      result.configured.push('Codex plugin (hooks, workflow skill, MCP)');
      return;
    } catch (err: any) {
      result.warnings.push(
        `Codex plugin unavailable (${err.message}); falling back to direct MCP configuration`,
      );
    }

    try {
      await execFileAsync(
        codexBin,
        ['mcp', 'add', 'gitnexus', '--', entry.command, ...entry.args],
        { shell: process.platform === 'win32', timeout: EXTERNAL_COMMAND_TIMEOUT_MS },
      );
      await verifyCodexMcpRegistration(codexBin, entry);
      result.configured.push('Codex (direct MCP fallback)');
      return;
    } catch (err: any) {
      result.warnings.push(
        `Codex CLI MCP setup failed (${err.message}); falling back to ${paths.configPath}`,
      );
    }
  }

  if (!codexBin && paths.scope === 'user') {
    result.warnings.push(
      'Codex CLI was not found; installed direct MCP config and detailed skills, but plugin hooks could not be enabled',
    );
  }

  try {
    await upsertCodexConfigToml(paths.configPath, entry);
    result.configured.push(`Codex (${paths.scope} MCP config → ${paths.configPath})`);
    if (codexBin) {
      try {
        await verifyCodexMcpRegistration(codexBin, entry, paths.projectRoot);
      } catch (err: any) {
        result.warnings.push(
          `Codex MCP config was written but not active in codex mcp get (${err.message})${paths.scope === 'project' ? '; trust the project to load .codex/config.toml' : ''}`,
        );
      }
    }
  } catch (err: any) {
    result.errors.push(`Codex: ${err.message}`);
  }
}

async function setupHermes(result: SetupResult): Promise<void> {
  const hermesDir = path.join(os.homedir(), '.hermes');
  const hermesBin = resolveCommandBin('hermes');
  const hasHermesHome = await dirExists(hermesDir);

  if (!hasHermesHome) {
    result.skipped.push('Hermes (not installed)');
    return;
  }

  if (!hermesBin) {
    result.errors.push(
      'Hermes: ~/.hermes exists but `hermes` command is not on PATH — run `hermes mcp add gitnexus --command gitnexus --args mcp` manually',
    );
    return;
  }

  try {
    const entry = getMcpEntry();
    await execFileWithInput(
      hermesBin,
      ['mcp', 'add', 'gitnexus', '--command', entry.command, '--args', ...entry.args],
      {
        input: 'Y\n',
        shell: process.platform === 'win32',
      },
    );
    result.configured.push('Hermes');
  } catch (err: any) {
    result.errors.push(`Hermes: ${err.message}`);
  }
}

// ─── Skill Installation ───────────────────────────────────────────

/**
 * Install GitNexus skills to a target directory.
 * Each skill is installed as {targetDir}/gitnexus-{skillName}/SKILL.md
 * following the Agent Skills standard (Cursor, Claude Code, and Codex).
 *
 * Supports two source layouts:
 *   - Flat file:  skills/{name}.md           → copied as SKILL.md
 *   - Directory:  skills/{name}/SKILL.md     → copied recursively (includes references/, etc.)
 */
interface SkillInstallResult {
  installed: string[];
  preserved: string[];
}

async function skillFileExists(skillDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(skillDir, 'SKILL.md'));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function installSkillsTo(
  targetDir: string,
  options: { preserveExisting?: boolean } = {},
): Promise<SkillInstallResult> {
  const installed: string[] = [];
  const preserved: string[] = [];
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');

  let flatFiles: string[] = [];
  let dirSkillFiles: string[] = [];
  try {
    [flatFiles, dirSkillFiles] = await Promise.all([
      glob('*.md', { cwd: skillsRoot }),
      glob('*/SKILL.md', { cwd: skillsRoot }),
    ]);
  } catch {
    return { installed, preserved };
  }

  const skillSources = new Map<string, { isDirectory: boolean }>();

  for (const relPath of dirSkillFiles) {
    skillSources.set(path.dirname(relPath), { isDirectory: true });
  }
  for (const relPath of flatFiles) {
    const skillName = path.basename(relPath, '.md');
    if (!skillSources.has(skillName)) {
      skillSources.set(skillName, { isDirectory: false });
    }
  }

  for (const [skillName, source] of skillSources) {
    const skillDir = path.join(targetDir, skillName);

    try {
      if (options.preserveExisting && (await skillFileExists(skillDir))) {
        preserved.push(skillName);
        continue;
      }

      if (source.isDirectory) {
        const dirSource = path.join(skillsRoot, skillName);
        await copyDirRecursive(dirSource, skillDir);
        installed.push(skillName);
      } else {
        const flatSource = path.join(skillsRoot, `${skillName}.md`);
        const content = await fs.readFile(flatSource, 'utf-8');
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        installed.push(skillName);
      }
    } catch {
      // Source skill not found — skip
    }
  }

  return { installed, preserved };
}

/**
 * Recursively copy a directory tree.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Install global Cursor skills to ~/.cursor/skills/gitnexus/
 */
async function installCursorSkills(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) return;

  const skillsDir = path.join(cursorDir, 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.installed.length > 0) {
      result.configured.push(
        `Cursor skills (${installed.installed.length} skills → ~/.cursor/skills/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`Cursor skills: ${err.message}`);
  }
}

/**
 * Install global OpenCode skills to ~/.config/opencode/skills/gitnexus/
 */
async function installOpenCodeSkills(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) return;

  const skillsDir = path.join(opencodeDir, 'skills');
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.installed.length > 0) {
      result.configured.push(
        `OpenCode skills (${installed.installed.length} skills → ~/.config/opencode/skill/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`OpenCode skills: ${err.message}`);
  }
}

/**
 * Install Codex skills as direct ~/.agents/skills/gitnexus-* children (or the
 * equivalent project-scoped .agents/skills directory).
 */
async function installCodexSkills(result: SetupResult, paths: CodexSetupPaths): Promise<void> {
  try {
    const installed = await installSkillsTo(paths.skillsDir);
    if (installed.installed.length > 0) {
      result.configured.push(
        `Codex detailed skills (${installed.installed.length} skills → ${paths.skillsDir})`,
      );
    }
  } catch (err: any) {
    result.errors.push(`Codex skills: ${err.message}`);
  }
}

/**
 * Install global Hermes skills to ~/.hermes/skills/software-development/.
 */
async function installHermesSkills(result: SetupResult): Promise<void> {
  const hermesDir = path.join(os.homedir(), '.hermes');
  if (!(await dirExists(hermesDir))) return;

  const skillsDir = path.join(hermesDir, 'skills', 'software-development');
  try {
    const installed = await installSkillsTo(skillsDir, { preserveExisting: true });
    if (installed.installed.length > 0 || installed.preserved.length > 0) {
      result.configured.push(
        `Hermes skills (${installed.installed.length} installed, ${installed.preserved.length} preserved existing → ~/.hermes/skills/software-development/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`Hermes skills: ${err.message}`);
  }
}

// ─── Main command ──────────────────────────────────────────────────

export const setupCommand = async (options: SetupOptions = {}): Promise<SetupResult> => {
  console.log('');
  console.log('  GitNexus Setup');
  console.log('  ==============');
  console.log('');

  // Ensure global directory exists
  const globalDir = getGlobalDir();
  await fs.mkdir(globalDir, { recursive: true });

  const codexPaths = resolveCodexSetupPaths(options);
  const result: SetupResult = {
    configured: [],
    skipped: [],
    warnings: [],
    errors: [],
  };

  // Detect and configure each editor's MCP
  await setupCursor(result);
  await setupClaudeCode(result);
  await setupOpenCode(result);
  await setupCodex(result, codexPaths);
  await setupHermes(result);

  // Install global skills for platforms that support them
  await installClaudeCodeSkills(result);
  await installClaudeCodeHooks(result);
  await installCursorSkills(result);
  await installOpenCodeSkills(result);
  await installCodexSkills(result, codexPaths);
  await installHermesSkills(result);

  // Print results
  if (result.configured.length > 0) {
    console.log('  Configured:');
    for (const name of result.configured) {
      console.log(`    + ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  Skipped:');
    for (const name of result.skipped) {
      console.log(`    - ${name}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log('  Warnings:');
    for (const warning of result.warnings) {
      console.log(`    ! ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const err of result.errors) {
      console.log(`    ! ${err}`);
    }
  }

  console.log('');
  console.log('  Summary:');
  console.log(
    `    MCP configured for: ${result.configured.filter((c) => !c.includes('skills')).join(', ') || 'none'}`,
  );
  console.log(
    `    Skills installed to: ${result.configured.filter((c) => c.includes('skills')).length > 0 ? result.configured.filter((c) => c.includes('skills')).join(', ') : 'none'}`,
  );
  console.log('');
  console.log('  Next steps:');
  console.log('    1. cd into any git repo');
  console.log('    2. Run: gitnexus analyze');
  console.log('    3. Open the repo in your editor — MCP is ready!');
  console.log('');
  return result;
};
