#!/usr/bin/env node
'use strict';

/**
 * Codex lifecycle hook for GitNexus.
 *
 * The Bash PreToolUse hook enriches rg/grep searches with graph context.
 * A separate, exact MCP matcher gates read-only graph queries until the
 * target worktree reports a fresh index. Git mutations only write a compact
 * stale marker; they never run refresh ensure/analyze from a hook.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_PATTERN_LENGTH = 200;
const MAX_CONTEXT_LENGTH = 12_000;
// The graph gate itself has a 10s Codex timeout. Keep its worst-case path
// (git root + status + request) below that budget; a hook must never time out
// before it can emit its fail-closed decision.
const REFRESH_STATUS_TIMEOUT_MS = 2_500;
const REFRESH_REQUEST_TIMEOUT_MS = 2_500;
const REFRESH_MARK_TIMEOUT_MS = 4_000;

// Keep this list in sync with hooks.json. It intentionally excludes
// list_repos, detect_changes, group_list, and every mutating MCP tool.
const GATED_GRAPH_TOOL_NAMES = new Set([
  'mcp__gitnexus__query',
  'mcp__gitnexus__cypher',
  'mcp__gitnexus__context',
  'mcp__gitnexus__impact',
  'mcp__gitnexus__route_map',
  'mcp__gitnexus__tool_map',
  'mcp__gitnexus__shape_check',
  'mcp__gitnexus__api_impact',
]);

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

function worktreeRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const root = (result.stdout || '').trim();
    if (result.status !== 0 || !path.isAbsolute(root)) return null;
    try {
      return fs.realpathSync.native(root);
    } catch {
      return path.resolve(root);
    }
  } catch {
    return null;
  }
}

function findIndex(cwd) {
  const root = worktreeRoot(cwd);
  // A linked worktree must never borrow the primary checkout's graph: its
  // source tree and HEAD can differ. Fall back only for non-Git callers.
  return root ? walkForIndex(root) : walkForIndex(cwd);
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

function configuredCliPath() {
  const configured = process.env.GITNEXUS_CLI;
  // Accepting a bare command or a shell fragment here would make hook
  // execution depend on ambiguous PATH/shell parsing. Overrides must be an
  // explicit executable path; the normal fallback below deliberately uses
  // only the already-installed `gitnexus` command from PATH.
  if (!configured || !path.isAbsolute(configured)) return null;

  try {
    const resolved = fs.realpathSync.native(configured);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * `CreateProcess` cannot execute a .cmd/.bat file directly. Do not use
 * `shell: true` here: hook arguments include worktree paths and must remain
 * argv values rather than a concatenated shell command. Node performs normal
 * Windows argv quoting for the explicit cmd.exe invocation below.
 */
function cliLaunch(command, args, platform = process.platform, comSpec = process.env.ComSpec) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: comSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

function runGitNexus(args, cwd, timeoutMs) {
  // A Codex plugin is cached as the plugin bundle only; it does not include
  // GitNexus's package-level dist/ CLI. Never infer a sibling dist path or
  // fall back to a package runner: either could fail in the cache or permit a
  // network/package-resolution path from a lifecycle hook.
  const command =
    configuredCliPath() || (process.platform === 'win32' ? 'gitnexus.cmd' : 'gitnexus');
  const launch = cliLaunch(command, args);
  return spawnSync(launch.command, launch.args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Keep Node's normal Windows quoting. In particular, never concatenate
    // a worktree path into a cmd.exe command string.
    windowsVerbatimArguments: false,
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

function sendGraphGateDeny(reason, message) {
  const boundedReason = String(reason).slice(0, MAX_CONTEXT_LENGTH);
  const boundedMessage = String(message).slice(0, MAX_CONTEXT_LENGTH);
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: boundedReason,
        additionalContext: boundedMessage,
      },
    })}\n`,
  );
}

function isGatedGraphTool(toolName) {
  return typeof toolName === 'string' && GATED_GRAPH_TOOL_NAMES.has(toolName);
}

function parseRefreshStatus(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}

function refreshInstruction(worktreePath) {
  const quotedPath = shellQuote(worktreePath);
  return (
    `Run \`gitnexus refresh init --path ${quotedPath}\` once if this worktree is new, then ` +
    `\`gitnexus refresh ensure --path ${quotedPath}\`, and retry the graph query.`
  );
}

function markStale(worktreePath, reason) {
  try {
    return runGitNexus(
      ['refresh', 'mark', '--path', worktreePath, '--reason', reason],
      worktreePath,
      REFRESH_MARK_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
}

// The request action detaches a coordinator-owned `ensure` process. It is
// intentionally quick: the Hook never performs an index rebuild itself and
// still denies this particular graph call until the refreshed graph exists.
function requestRefresh(worktreePath, reason) {
  try {
    return runGitNexus(
      ['refresh', 'request', '--path', worktreePath, '--reason', reason, '--json'],
      worktreePath,
      REFRESH_REQUEST_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
}

function resolveGraphWorktree(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const currentWorktree = worktreeRoot(cwd);
  if (!currentWorktree) {
    return { error: 'Codex did not provide an absolute Git worktree for this graph query.' };
  }

  const repo = input.tool_input?.repo;
  if (repo === undefined || repo === null || repo === '') {
    return {
      error:
        'This GitNexus graph query must include `repo` as an absolute worktree path. ' +
        'The MCP server cannot infer the Codex client worktree safely when multiple repositories are indexed.',
    };
  }
  if (typeof repo !== 'string') {
    return { error: 'The GitNexus repo argument must be an absolute worktree path.' };
  }
  if (repo.startsWith('@')) {
    return {
      error:
        'Cross-repository GitNexus groups cannot be freshness-checked from one worktree. ' +
        'Refresh each member explicitly before querying the group.',
    };
  }
  if (!path.isAbsolute(repo)) {
    return {
      error:
        'The GitNexus graph-query gate accepts only an absolute `repo` worktree path. ' +
        'A registry alias can resolve to another checkout.',
    };
  }

  const requestedWorktree = worktreeRoot(repo);
  if (!requestedWorktree) {
    return { error: `The requested GitNexus repo path is not an absolute Git worktree: ${repo}` };
  }
  return { worktreePath: requestedWorktree };
}

function graphGateMessage(worktreePath, reason, requestState, cliUnavailable) {
  const queueMessage =
    requestState === 'queued'
      ? 'The hook requested a coordinator-owned background refresh; it did not run analyze itself. '
      : requestState === 'already-queued'
        ? 'A coordinator-owned background refresh is already pending; the hook did not run analyze itself. '
        : cliUnavailable
          ? 'The hook could not queue a background refresh because no usable local GitNexus CLI was found. ' +
            'Set `GITNEXUS_CLI` to an absolute executable path or put `gitnexus` on PATH, then retry. '
          : 'The hook could not queue a background refresh before its deadline (it may already be busy). ' +
            'Run the synchronous refresh command below, then retry. ';
  const retryMessage =
    requestState === 'queued' || requestState === 'already-queued'
      ? 'Retry after it completes, or '
      : 'Run ';
  return (
    `GitNexus blocked this graph query: ${reason} ` +
    queueMessage +
    `${retryMessage}${refreshInstruction(worktreePath)} ` +
    '`detect_changes` is intentionally not gated and remains available for working-tree diffs.'
  );
}

function handleGraphToolPreUse(input) {
  if (!isGatedGraphTool(input.tool_name)) return;

  const target = resolveGraphWorktree(input);
  if (target.error) {
    sendGraphGateDeny(target.error, `GitNexus graph query blocked. ${target.error}`);
    return;
  }

  let statusResult;
  try {
    statusResult = runGitNexus(
      ['refresh', 'status', '--path', target.worktreePath, '--json'],
      target.worktreePath,
      REFRESH_STATUS_TIMEOUT_MS,
    );
  } catch {
    statusResult = null;
  }
  const status = parseRefreshStatus(statusResult);

  const isFresh = statusResult?.status === 0 && status?.refreshRequired === false;
  if (isFresh) return;

  // `request` owns the demand refresh and makes a stale marker unnecessary
  // here. History hooks still record markers independently. Avoid doing two
  // synchronous CLI calls after status: the graph gate must emit its deny
  // response within Codex's hook timeout.
  const requestResult = requestRefresh(target.worktreePath, 'mcp-graph-request');
  const requestStatus = parseRefreshStatus(requestResult);
  const requestState =
    requestResult?.status === 0 &&
    (requestStatus?.requestState === 'queued' || requestStatus?.requestState === 'already-queued')
      ? requestStatus.requestState
      : undefined;
  const cliUnavailable = Boolean(
    requestStatus?.requestState === 'unavailable' ||
    !requestResult ||
    requestResult.error?.code === 'ENOENT' ||
    requestResult.error?.code === 'EACCES',
  );

  const reason =
    (typeof status?.reason === 'string' && status.reason) ||
    (status
      ? 'the worktree index requires refresh'
      : 'freshness could not be verified (refresh status returned no valid JSON)');
  sendGraphGateDeny(
    reason,
    graphGateMessage(target.worktreePath, reason, requestState, cliUnavailable),
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
    if (!result || result.status !== 0 || result.error) return;
    const context = (result.stderr || result.stdout || '').trim();
    if (context) sendAdditionalContext('PreToolUse', context);
  } catch {
    // Search enrichment must never block the underlying command.
  }
}

function parseGitMutation(command) {
  if (typeof command !== 'string') return null;
  const tokens = shellTokens(command).map(cleanToken);
  // `reset` has no portable post-reset Git hook, so the Codex Bash path is
  // the only automatic stale marker for a reset that moves HEAD.
  const mutations = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'pull', 'reset']);

  for (let index = 0; index < tokens.length; index += 1) {
    if (path.basename(tokens[index]) !== 'git') continue;
    const directories = [];
    for (let argIndex = index + 1; argIndex < tokens.length; argIndex += 1) {
      const token = tokens[argIndex];
      if (token === '-C') {
        const directory = tokens[argIndex + 1];
        if (!directory) return null;
        directories.push(directory);
        argIndex += 1;
        continue;
      }
      // Git also accepts `-C<path>`. Keep this case separate from lowercase
      // `-c`, which sets an ephemeral config key rather than changing cwd.
      if (token.startsWith('-C') && token.length > 2) {
        directories.push(token.slice(2));
        continue;
      }
      if (token === '-c' || token === '--git-dir' || token === '--work-tree') {
        argIndex += 1;
        continue;
      }
      if (token.startsWith('-')) continue;
      return mutations.has(token) ? { verb: token, directories } : null;
    }
  }
  return null;
}

function gitMutationVerb(command) {
  return parseGitMutation(command)?.verb || null;
}

/**
 * Resolve Git's sequential `-C <path>` options relative to the shell cwd.
 * A Codex Bash command can commit a different linked worktree without
 * changing `input.cwd`; stale state must follow Git's effective cwd.
 */
function gitMutationTarget(command, cwd) {
  const mutation = parseGitMutation(command);
  if (!mutation || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let effectiveCwd = path.resolve(cwd);
  for (const directory of mutation.directories) {
    effectiveCwd = path.resolve(effectiveCwd, directory);
  }
  return { verb: mutation.verb, cwd: effectiveCwd };
}

function responseExitCode(response) {
  if (!response || typeof response !== 'object') return undefined;
  const candidates = [response.exit_code, response.exitCode, response.metadata?.exit_code];
  return candidates.find((value) => typeof value === 'number');
}

function handlePostToolUse(input) {
  if (input.tool_name !== 'Bash') return;
  const cwd = input.cwd || process.cwd();
  const mutation = gitMutationTarget(input.tool_input?.command, cwd);
  if (!mutation) return;
  const exitCode = responseExitCode(input.tool_response);
  if (exitCode !== undefined && exitCode !== 0) return;

  const root = worktreeRoot(mutation.cwd);
  if (!root) return;

  const markResult = markStale(root, `git-${mutation.verb}`);
  const markFailed = !markResult || markResult.status !== 0 || markResult.error;

  sendAdditionalContext(
    'PostToolUse',
    markFailed
      ? `GitNexus could not record a stale marker after git ${mutation.verb}. Graph queries will fail closed ` +
          `until freshness is verified. ${refreshInstruction(root)}`
      : `GitNexus marked this worktree stale after git ${mutation.verb}. Graph queries will be gated until ` +
          `\`gitnexus refresh ensure --path ${shellQuote(root)}\` completes; ` +
          '`detect_changes` remains available for working-tree diffs.',
  );
}

function main() {
  try {
    const input = readInput();
    if (input.hook_event_name === 'PreToolUse') {
      handlePreToolUse(input);
      handleGraphToolPreUse(input);
    }
    if (input.hook_event_name === 'PostToolUse') handlePostToolUse(input);
  } catch (error) {
    if (process.env.GITNEXUS_DEBUG) {
      process.stderr.write(`GitNexus Codex hook error: ${String(error).slice(0, 200)}\n`);
    }
  }
}

module.exports = {
  cliLaunch,
  extractSearchPattern,
  findIndex,
  gitMutationTarget,
  gitMutationVerb,
  handleGraphToolPreUse,
  handlePostToolUse,
  handlePreToolUse,
  isGatedGraphTool,
  parseRefreshStatus,
  runGitNexus,
  responseExitCode,
  resolveGraphWorktree,
  worktreeRoot,
};

if (require.main === module) main();
