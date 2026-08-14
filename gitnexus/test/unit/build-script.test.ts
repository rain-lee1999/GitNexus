import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBinInvocation, runBin } from '../../scripts/build-bin.js';

const tempRoots: string[] = [];

function tempDir(prefix = 'gitnexus-build-bin-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeTypeScriptBin(root: string): string {
  const packageRoot = path.join(root, 'node_modules', 'typescript');
  const binPath = path.join(packageRoot, 'bin', 'tsc.js');
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc.js' } }),
  );
  fs.writeFileSync(binPath, 'process.exitCode = 0;\n');
  return binPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('build binary resolution', () => {
  it('invokes the JavaScript package bin with Node instead of a platform command shim', () => {
    const cwd = tempDir();
    const fallbackRoot = tempDir();
    const tscPath = writeTypeScriptBin(cwd);
    const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';

    expect(
      resolveBinInvocation('tsc', ['--pretty', 'false'], cwd, fallbackRoot, nodeExecutable),
    ).toEqual({
      file: nodeExecutable,
      args: [tscPath, '--pretty', 'false'],
    });
  });

  it('uses the build root package bin when the target directory has no local installation', () => {
    const cwd = tempDir();
    const fallbackRoot = tempDir();
    const tscPath = writeTypeScriptBin(fallbackRoot);

    expect(resolveBinInvocation('tsc', [], cwd, fallbackRoot, process.execPath)).toEqual({
      file: process.execPath,
      args: [tscPath],
    });
  });

  it('executes the JavaScript package bin through Node from a path containing spaces', () => {
    const cwd = tempDir('gitnexus build bin ');
    const fallbackRoot = tempDir();
    const markerPath = path.join(cwd, 'executed.txt');
    const tscPath = writeTypeScriptBin(cwd);
    fs.writeFileSync(tscPath, "require('node:fs').writeFileSync(process.argv[2], 'executed');\n");

    runBin('tsc', [markerPath], cwd, fallbackRoot);

    expect(fs.readFileSync(markerPath, 'utf8')).toBe('executed');
  });

  it('fails closed when the required package metadata is unavailable', () => {
    const cwd = tempDir();
    const fallbackRoot = tempDir();

    expect(() => resolveBinInvocation('tsc', [], cwd, fallbackRoot)).toThrow(
      'Unable to resolve the Node package bin "tsc"',
    );
  });
});
