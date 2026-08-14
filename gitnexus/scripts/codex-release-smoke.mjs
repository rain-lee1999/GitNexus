#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFile = promisify(execFileCallback);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commandTimeoutMs = 600_000;
const protocolTimeoutMs = 30_000;

function commandEnvironment(homeRoot, codexHome, npmCache) {
  return {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    CODEX_HOME: codexHome,
    NO_UPDATE_NOTIFIER: '1',
    npm_config_audit: 'false',
    npm_config_cache: npmCache,
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

async function run(command, args, options = {}) {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd ?? packageRoot,
      env: options.env ?? process.env,
      timeout: options.timeout ?? commandTimeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const details = [error.stderr, error.stdout]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
      .join('\n');
    if (details) error.message += `\n${details.slice(-8_000)}`;
    throw error;
  }
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (initialError) {
    // npm lifecycle scripts may write build output to stdout before `npm pack
    // --json` emits its final document. Walk backward through line-aligned JSON
    // candidates so the smoke test still exercises the real prepack lifecycle.
    for (
      let index = stdout.lastIndexOf('\n[');
      index >= 0;
      index = stdout.lastIndexOf('\n[', index - 1)
    ) {
      try {
        return JSON.parse(stdout.slice(index + 1));
      } catch {
        // Continue until the trailing JSON document is found.
      }
    }
    const tail = stdout.length > 4_000 ? stdout.slice(-4_000) : stdout;
    throw new Error(`${label} did not return valid JSON: ${initialError.message}\n${tail}`);
  }
}

function assertMcpRegistration(registration, version) {
  assert.equal(registration.name, 'gitnexus');
  assert.equal(registration.enabled, true);
  assert.equal(registration.transport?.type, 'stdio');
  assert.equal(registration.transport?.command, 'npx');
  assert.deepEqual(registration.transport?.args, ['-y', `gitnexus@${version}`, 'mcp']);
}

async function verifyMcpProtocol(installedPackageRoot, isolatedEnvironment) {
  const cliEntry = path.join(installedPackageRoot, 'dist', 'cli', 'index.js');
  const client = new Client({ name: 'gitnexus-codex-release-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, 'mcp'],
    cwd: packageRoot,
    env: isolatedEnvironment,
    stderr: 'pipe',
  });
  let serverStderr = '';
  transport.stderr?.on('data', (chunk) => {
    serverStderr += String(chunk);
  });

  try {
    await client.connect(transport, { timeout: protocolTimeoutMs });

    const instructions = client.getInstructions();
    assert.equal(typeof instructions, 'string', 'initialize must return server instructions');
    assert.ok(instructions.length > 0, 'initialize instructions must not be empty');
    assert.ok(
      instructions.slice(0, 512).includes('impact'),
      'the self-contained instruction window must explain impact analysis',
    );

    const tools = await client.listTools(undefined, { timeout: protocolTimeoutMs });
    assert.equal(tools.tools.length, 13, 'the release package must expose exactly 13 MCP tools');
    assert.ok(tools.tools.some((tool) => tool.name === 'list_repos'));

    const listRepos = await client.callTool({ name: 'list_repos', arguments: {} }, undefined, {
      timeout: protocolTimeoutMs,
    });
    assert.notEqual(listRepos.isError, true, `list_repos failed: ${JSON.stringify(listRepos)}`);
    assert.ok(Array.isArray(listRepos.content) && listRepos.content.length > 0);

    return {
      instructionsLength: instructions.length,
      server: client.getServerVersion(),
      toolCount: tools.tools.length,
    };
  } catch (error) {
    if (serverStderr) error.message += `\nMCP stderr:\n${serverStderr}`;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const codexBin = process.env.CODEX_BIN || 'codex';
  const npmBin = process.env.npm_execpath
    ? process.execPath
    : process.platform === 'win32'
      ? 'npm.cmd'
      : 'npm';
  const npmPrefixArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];
  const smokeRoot = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-codex-release-'));
  const packRoot = path.join(smokeRoot, 'pack');
  const installRoot = path.join(smokeRoot, 'install');
  const homeRoot = path.join(smokeRoot, 'home');
  const codexHome = path.join(smokeRoot, 'codex-home');
  const npmCacheRoot = process.env.GITNEXUS_SMOKE_NPM_CACHE || path.join(smokeRoot, 'npm-cache');

  await Promise.all(
    [packRoot, installRoot, homeRoot, codexHome, npmCacheRoot].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const isolatedEnvironment = commandEnvironment(homeRoot, codexHome, npmCacheRoot);

  try {
    const packResult = await run(
      npmBin,
      [...npmPrefixArgs, 'pack', '--json', '--pack-destination', packRoot],
      { cwd: packageRoot, env: isolatedEnvironment },
    );
    const packMetadata = parseJson(packResult.stdout, 'npm pack');
    assert.equal(packMetadata.length, 1);
    assert.equal(packMetadata[0].version, packageJson.version);
    const packedPaths = new Set(packMetadata[0].files.map((entry) => entry.path));
    assert.ok(packedPaths.has('dist/cli/index.js'), 'tarball is missing the compiled CLI');
    assert.ok(
      packedPaths.has('codex-plugin/.codex-plugin/plugin.json'),
      'tarball is missing the Codex plugin manifest',
    );
    const tarballPath = path.join(packRoot, packMetadata[0].filename);

    await run(
      npmBin,
      [
        ...npmPrefixArgs,
        'install',
        '--no-audit',
        '--no-fund',
        '--prefix',
        installRoot,
        tarballPath,
      ],
      { cwd: smokeRoot, env: isolatedEnvironment },
    );

    const installedPackageRoot = path.join(installRoot, 'node_modules', 'gitnexus');
    const installedPackage = JSON.parse(
      await readFile(path.join(installedPackageRoot, 'package.json'), 'utf8'),
    );
    assert.equal(installedPackage.version, packageJson.version);

    const codexVersion = await run(codexBin, ['--version'], { env: isolatedEnvironment });
    assert.match(codexVersion.stdout, /codex-cli \d+\.\d+\.\d+/);
    if (process.env.CODEX_CLI_VERSION) {
      assert.equal(codexVersion.stdout, `codex-cli ${process.env.CODEX_CLI_VERSION}`);
    }

    const pluginRoot = path.join(installedPackageRoot, 'codex-plugin');
    const marketplace = parseJson(
      (
        await run(codexBin, ['plugin', 'marketplace', 'add', pluginRoot, '--json'], {
          env: isolatedEnvironment,
        })
      ).stdout,
      'codex plugin marketplace add',
    );
    assert.equal(marketplace.marketplaceName, 'gitnexus');

    const plugin = parseJson(
      (
        await run(codexBin, ['plugin', 'add', 'gitnexus@gitnexus', '--json'], {
          env: isolatedEnvironment,
        })
      ).stdout,
      'codex plugin add',
    );
    assert.equal(plugin.pluginId, 'gitnexus@gitnexus');
    assert.equal(plugin.version, packageJson.version);
    const canonicalPluginPath = await realpath(plugin.installedPath);
    const canonicalCodexHome = await realpath(codexHome);
    assert.ok(
      canonicalPluginPath.startsWith(canonicalCodexHome + path.sep),
      'the plugin must be installed under the isolated CODEX_HOME',
    );

    const mcpList = parseJson(
      (await run(codexBin, ['mcp', 'list', '--json'], { env: isolatedEnvironment })).stdout,
      'codex mcp list',
    );
    const listEntry = mcpList.find((entry) => entry.name === 'gitnexus');
    assert.ok(listEntry, 'codex mcp list is missing gitnexus');
    assertMcpRegistration(listEntry, packageJson.version);

    const mcpGet = parseJson(
      (await run(codexBin, ['mcp', 'get', 'gitnexus', '--json'], { env: isolatedEnvironment }))
        .stdout,
      'codex mcp get',
    );
    assertMcpRegistration(mcpGet, packageJson.version);

    const protocol = await verifyMcpProtocol(installedPackageRoot, isolatedEnvironment);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          package: `gitnexus@${packageJson.version}`,
          codex: codexVersion.stdout,
          plugin: plugin.pluginId,
          mcp: protocol,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (process.env.GITNEXUS_KEEP_SMOKE_DIR === '1') {
      process.stderr.write(`Preserved smoke directory: ${smokeRoot}\n`);
    } else {
      await rm(smokeRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
