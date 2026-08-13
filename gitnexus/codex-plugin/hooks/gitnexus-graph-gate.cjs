#!/usr/bin/env node
'use strict';

/**
 * Codex graph-query freshness gate for GitNexus.
 *
 * This is intentionally separate from gitnexus-hook.cjs so the advisory
 * Bash search and stale-marker hooks retain their reviewed source. The gate
 * checks freshness only; it never starts, queues, or otherwise performs a
 * refresh because its lifecycle payload does not prove write authorization
 * for the target worktree or the global GitNexus home.
 */

const fs = require('node:fs');
const { parseRefreshStatus, resolveGraphWorktree, runGitNexus } = require('./gitnexus-hook.cjs');

const MAX_CONTEXT_LENGTH = 12_000;
const REFRESH_STATUS_TIMEOUT_MS = 2_500;

// Keep this list in sync with hooks.json. The manifest is the primary
// lifecycle boundary; this guard also makes direct invocation fail closed.
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}

function refreshInstruction(worktreePath) {
  const quotedPath = shellQuote(worktreePath);
  return (
    `First inspect \`gitnexus refresh status --path ${quotedPath} --json\` and ` +
    `\`gitnexus refresh plan --path ${quotedPath} --json\`. ` +
    `\`gitnexus refresh init\` and \`gitnexus refresh ensure\` are write operations: ` +
    `they can write the worktree's \`.gitnexus/\`, Git metadata, and ` +
    `\`$GITNEXUS_HOME\` (including the global registry and locks). ` +
    `Run init/ensure only when this task has write access to every GitNexus target or after scoped approval.`
  );
}

function graphGateMessage(worktreePath, reason, cliUnavailable) {
  const availabilityMessage = cliUnavailable
    ? 'The hook could not run status because no usable local GitNexus CLI was found. ' +
      'Set `GITNEXUS_CLI` to an absolute executable path or put `gitnexus` on PATH. '
    : '';
  return (
    `GitNexus blocked this graph query: ${reason} ` +
    `The hook ran only \`gitnexus refresh status\` and did not start or queue a refresh. ` +
    availabilityMessage +
    `${refreshInstruction(worktreePath)} ` +
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
  if (statusResult?.status === 0 && status?.refreshRequired === false) return;

  const cliUnavailable = Boolean(
    !statusResult || statusResult.error?.code === 'ENOENT' || statusResult.error?.code === 'EACCES',
  );
  const reason =
    (typeof status?.reason === 'string' && status.reason) ||
    (status
      ? 'the worktree index requires refresh'
      : 'freshness could not be verified (refresh status returned no valid JSON)');
  sendGraphGateDeny(reason, graphGateMessage(target.worktreePath, reason, cliUnavailable));
}

function main() {
  try {
    const input = readInput();
    if (input.hook_event_name === 'PreToolUse') handleGraphToolPreUse(input);
  } catch (error) {
    if (process.env.GITNEXUS_DEBUG) {
      process.stderr.write(`GitNexus Codex graph gate error: ${String(error).slice(0, 200)}\n`);
    }
  }
}

module.exports = {
  graphGateMessage,
  handleGraphToolPreUse,
  isGatedGraphTool,
  refreshInstruction,
};

if (require.main === module) main();
