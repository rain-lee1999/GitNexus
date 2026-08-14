#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(packageRoot, 'package.json');
const targets = [
  path.join(packageRoot, 'codex-plugin', '.codex-plugin', 'plugin.json'),
  path.join(packageRoot, 'codex-plugin', '.agents', 'plugins', 'marketplace.json'),
  path.join(packageRoot, 'codex-plugin', '.mcp.json'),
];
const relativeTargets = targets.map((target) => path.relative(packageRoot, target));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function replaceFirstVersion(raw, version, label) {
  const replaced = raw.replace(/^(\s*"version"\s*:\s*")[^"]+("\s*,?)/m, `$1${version}$2`);
  if (replaced === raw && !raw.includes(`"version": "${version}"`)) {
    throw new Error(`${label} is missing a version field.`);
  }
  return replaced;
}

function expectedDocuments(version) {
  const current = targets.map((target) => fs.readFileSync(target, 'utf8'));
  const manifest = replaceFirstVersion(current[0], version, 'Codex plugin manifest');

  const marketplaceDocument = readJson(targets[1]);
  const plugin = marketplaceDocument.plugins?.find((candidate) => candidate.name === 'gitnexus');
  if (!plugin) throw new Error('Codex marketplace is missing the gitnexus plugin entry.');
  const marketplace = replaceFirstVersion(current[1], version, 'Codex marketplace');

  const mcpDocument = readJson(targets[2]);
  if (!Array.isArray(mcpDocument.gitnexus?.args)) {
    throw new Error('Codex plugin MCP config is missing gitnexus.args.');
  }
  const packageIndex = mcpDocument.gitnexus.args.findIndex(
    (arg) => typeof arg === 'string' && arg.startsWith('gitnexus@'),
  );
  if (packageIndex < 0) {
    throw new Error('Codex plugin MCP config must pin a gitnexus@<version> selector.');
  }
  const mcp = current[2].replace(/gitnexus@[^"\s]+/, `gitnexus@${version}`);

  // Validate the transformed documents before writing any of them.
  [manifest, marketplace, mcp].forEach((document) => JSON.parse(document));
  return [manifest, marketplace, mcp];
}

function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check');
  const stage = args.has('--stage');
  const packageJson = readJson(packageJsonPath);
  const expected = expectedDocuments(packageJson.version);
  const mismatches = [];

  targets.forEach((target, index) => {
    const current = fs.readFileSync(target, 'utf8');
    if (current === expected[index]) return;
    mismatches.push(relativeTargets[index]);
    if (!checkOnly) fs.writeFileSync(target, expected[index]);
  });

  if (checkOnly && mismatches.length > 0) {
    process.stderr.write(
      `Codex plugin version metadata is out of sync with package.json: ${mismatches.join(', ')}\n` +
        'Run `node scripts/sync-codex-plugin-version.cjs`.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (stage) {
    // `npm version` also exists in the published package. Only stage generated
    // metadata when this package is being versioned from its own source
    // checkout; an installed copy inside another repository must not attempt
    // to add files from node_modules to the consumer's index.
    const tracked = spawnSync(
      'git',
      ['ls-files', '--error-unmatch', '--', 'package.json', ...relativeTargets],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    if (tracked.status !== 0) return;

    const result = spawnSync('git', ['add', '--', ...relativeTargets], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`Failed to stage Codex plugin version metadata: ${result.stderr || ''}`);
    }
  }

  if (!checkOnly && mismatches.length > 0) {
    process.stdout.write(`Synced Codex plugin version ${packageJson.version}.\n`);
  }
}

main();
