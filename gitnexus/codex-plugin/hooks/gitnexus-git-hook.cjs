#!/usr/bin/env node
'use strict';

/**
 * Git hook template installed by `gitnexus refresh init --install-git-hooks`.
 *
 * The wrapper passes one supported Git hook name as `--event <name>` followed
 * by Git's original arguments. This process deliberately does one small,
 * fail-open operation: mark the current worktree stale. It never calls
 * `refresh ensure` or `analyze`, so a Git commit/merge is never delayed by a
 * graph rebuild.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUPPORTED_EVENTS = new Set(['post-commit', 'post-merge', 'post-rewrite', 'post-checkout']);
const MARK_TIMEOUT_MS = 4_000;

function worktreeRoot(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 2_000,
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

function configuredCliPath() {
  const configured = process.env.GITNEXUS_CLI;
  // A Git hook must not interpret a shell fragment or ambiguous command here.
  // Overrides use an explicit executable; the normal fallback is the
  // already-installed `gitnexus` command from PATH.
  if (!configured || !path.isAbsolute(configured)) return null;

  try {
    const resolved = fs.realpathSync.native(configured);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * .cmd/.bat shims need cmd.exe on Windows. Keep arguments as an argv array
 * and leave shell disabled so hook-controlled paths never become interpolated
 * command text.
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

function runGitNexus(args, cwd) {
  // The installed Codex plugin cache contains the plugin bundle, not a
  // package-level dist/ CLI. Do not infer a sibling path or fall back to a
  // package runner: hooks must not download packages or touch the network.
  const command =
    configuredCliPath() || (process.platform === 'win32' ? 'gitnexus.cmd' : 'gitnexus');
  const launch = cliLaunch(command, args);
  return spawnSync(launch.command, launch.args, {
    cwd,
    encoding: 'utf8',
    timeout: MARK_TIMEOUT_MS,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsVerbatimArguments: false,
  });
}

function parseInvocation(argv) {
  const args = [...argv];
  const eventIndex = args.indexOf('--event');
  if (eventIndex === -1 || !args[eventIndex + 1]) return null;
  return {
    event: args[eventIndex + 1],
    gitArgs: args.slice(eventIndex + 2),
  };
}

function shouldMark(event, gitArgs) {
  if (!SUPPORTED_EVENTS.has(event)) return false;
  // post-checkout's third argument is 1 for a branch checkout and 0 for a
  // file checkout. File checkout does not change HEAD, so it does not make a
  // committed graph stale.
  return event !== 'post-checkout' || gitArgs[2] !== '0';
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const invocation = parseInvocation(argv);
    if (!invocation || !shouldMark(invocation.event, invocation.gitArgs)) return;

    const root = worktreeRoot(cwd);
    if (!root) return;

    runGitNexus(['refresh', 'mark', '--path', root, '--reason', `git-${invocation.event}`], root);
  } catch {
    // Git hooks must never block the Git operation. The Codex graph-query
    // gate will fail closed if a later freshness check cannot be verified.
  }
}

module.exports = {
  SUPPORTED_EVENTS,
  cliLaunch,
  main,
  parseInvocation,
  runGitNexus,
  shouldMark,
  worktreeRoot,
};

if (require.main === module) main();
