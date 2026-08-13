#!/usr/bin/env node
'use strict';

/**
 * Codex lifecycle hook for GitNexus.
 *
 * PreToolUse enriches rg/grep searches with graph context. PostToolUse
 * advises re-indexing after a successful history-changing git command.
 * The hook is advisory and fails open; it never mutates the repository.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_PATTERN_LENGTH = 200;
const MAX_CONTEXT_LENGTH = 12_000;

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isGlobalRegistryDir(candidate) {
  if (fs.existsSync(path.join(candidate, 'meta.json'))) return false;
  return (
    fs.existsSync(path.join(candidate, 'registry.json')) ||
    fs.existsSync(path.join(candidate, 'repos'))
  );
}

function walkForIndex(startDir) {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, '.gitnexus');
    if (fs.existsSync(candidate) && !isGlobalRegistryDir(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function canonicalRepoRoot(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commonDir = (result.stdout || '').trim();
    if (result.status !== 0 || !path.isAbsolute(commonDir)) return null;
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

function findIndex(cwd) {
  const direct = walkForIndex(cwd);
  if (direct) return direct;
  const canonical = canonicalRepoRoot(cwd);
  return canonical ? walkForIndex(canonical) : null;
}

function shellTokens(command) {
  return command.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) || [];
}

function cleanToken(token) {
  const unquoted = token.replace(/^(['"])(.*)\1$/, '$2');
  return unquoted.replace(/\\([\s"'])/g, '$1');
}

function commandName(token) {
  return path.basename(cleanToken(token));
}

function extractSearchPattern(command) {
  if (typeof command !== 'string') return null;
  const tokens = shellTokens(command);
  const optionsWithValues = new Set([
    '-f',
    '--file',
    '-m',
    '--max-count',
    '-A',
    '--after-context',
    '-B',
    '--before-context',
    '-C',
    '--context',
    '-g',
    '--glob',
    '-t',
    '--type',
    '--include',
    '--exclude',
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const name = commandName(tokens[index]);
    if (name !== 'rg' && name !== 'grep') continue;

    for (let argIndex = index + 1; argIndex < tokens.length; argIndex += 1) {
      const token = cleanToken(tokens[argIndex]);
      if (token === '-e' || token === '--regexp') {
        const explicit = cleanToken(tokens[argIndex + 1] || '');
        return normalizePattern(explicit);
      }
      if (optionsWithValues.has(token)) {
        argIndex += 1;
        continue;
      }
      if (token.startsWith('-')) continue;
      return normalizePattern(token);
    }
  }

  return null;
}

function normalizePattern(pattern) {
  const normalized = String(pattern || '').trim();
  if (normalized.length < 3 || normalized.length > MAX_PATTERN_LENGTH) return null;
  return normalized;
}

function pluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function runGitNexus(args, cwd, timeoutMs) {
  const configured = process.env.GITNEXUS_CLI;
  if (configured) {
    return spawnSync(configured, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const isWindows = process.platform === 'win32';
  const which = spawnSync(isWindows ? 'where' : 'which', ['gitnexus'], {
    encoding: 'utf8',
    timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (which.status === 0) {
    return spawnSync(isWindows ? 'gitnexus.cmd' : 'gitnexus', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const version = pluginVersion();
  const packageSelector = version ? `gitnexus@${version}` : 'gitnexus';
  return spawnSync(isWindows ? 'npx.cmd' : 'npx', ['-y', packageSelector, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sendAdditionalContext(eventName, message) {
  const bounded = String(message).slice(0, MAX_CONTEXT_LENGTH);
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: bounded,
      },
    })}\n`,
  );
}

function handlePreToolUse(input) {
  if (input.tool_name !== 'Bash') return;
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd) || !findIndex(cwd)) return;

  const pattern = extractSearchPattern(input.tool_input?.command);
  if (!pattern) return;

  try {
    const result = runGitNexus(['augment', '--', pattern], cwd, 7000);
    if (result.status !== 0 || result.error) return;
    const context = (result.stderr || result.stdout || '').trim();
    if (context) sendAdditionalContext('PreToolUse', context);
  } catch {
    // Search enrichment must never block the underlying command.
  }
}

function gitMutationVerb(command) {
  if (typeof command !== 'string') return null;
  const tokens = shellTokens(command).map(cleanToken);
  const mutations = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'pull']);

  for (let index = 0; index < tokens.length; index += 1) {
    if (path.basename(tokens[index]) !== 'git') continue;
    for (let argIndex = index + 1; argIndex < tokens.length; argIndex += 1) {
      const token = tokens[argIndex];
      if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree') {
        argIndex += 1;
        continue;
      }
      if (token.startsWith('-')) continue;
      return mutations.has(token) ? token : null;
    }
  }
  return null;
}

function responseExitCode(response) {
  if (!response || typeof response !== 'object') return undefined;
  const candidates = [response.exit_code, response.exitCode, response.metadata?.exit_code];
  return candidates.find((value) => typeof value === 'number');
}

function handlePostToolUse(input) {
  if (input.tool_name !== 'Bash') return;
  if (!gitMutationVerb(input.tool_input?.command)) return;
  const exitCode = responseExitCode(input.tool_response);
  if (exitCode !== undefined && exitCode !== 0) return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const indexDir = findIndex(cwd);
  if (!indexDir) return;

  let head;
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return;
    head = (result.stdout || '').trim();
  } catch {
    return;
  }
  if (!head) return;

  let indexedCommit = '';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(indexDir, 'meta.json'), 'utf8'));
    indexedCommit = typeof meta.lastCommit === 'string' ? meta.lastCommit : '';
  } catch {
    // Missing metadata means the index needs a refresh.
  }
  if (head === indexedCommit) return;

  sendAdditionalContext(
    'PostToolUse',
    `GitNexus index is stale (last indexed: ${indexedCommit.slice(0, 7) || 'never'}). ` +
      'Run `npx gitnexus analyze` in the repository before relying on graph results; existing embeddings are preserved.',
  );
}

function main() {
  try {
    const input = readInput();
    if (input.hook_event_name === 'PreToolUse') handlePreToolUse(input);
    if (input.hook_event_name === 'PostToolUse') handlePostToolUse(input);
  } catch (error) {
    if (process.env.GITNEXUS_DEBUG) {
      process.stderr.write(`GitNexus Codex hook error: ${String(error).slice(0, 200)}\n`);
    }
  }
}

module.exports = {
  extractSearchPattern,
  findIndex,
  gitMutationVerb,
  handlePostToolUse,
  handlePreToolUse,
  responseExitCode,
};

if (require.main === module) main();
