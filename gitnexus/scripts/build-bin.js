import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NODE_BIN_PACKAGES = new Map([['tsc', 'typescript']]);

/**
 * Resolve Node-based package bins to their JavaScript entrypoint instead of
 * executing a platform shim. In particular, Windows cannot execFileSync a
 * `.cmd` shim directly.
 */
export function resolveBinInvocation(
  name,
  args,
  cwd,
  fallbackRoot,
  nodeExecutable = process.execPath,
) {
  const packageName = NODE_BIN_PACKAGES.get(name);

  if (packageName) {
    for (const root of new Set([cwd, fallbackRoot])) {
      const packageJsonPath = path.join(root, 'node_modules', packageName, 'package.json');
      if (!fs.existsSync(packageJsonPath)) continue;

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const relativeBin =
        typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[name];

      if (relativeBin) {
        return {
          file: nodeExecutable,
          args: [path.resolve(path.dirname(packageJsonPath), relativeBin), ...args],
        };
      }
    }

    throw new Error(
      `Unable to resolve the Node package bin "${name}" from ${cwd} or ${fallbackRoot}. Run npm install before building.`,
    );
  }

  return { file: name, args };
}

export function runBin(name, args, cwd, fallbackRoot) {
  const invocation = resolveBinInvocation(name, args, cwd, fallbackRoot);
  execFileSync(invocation.file, invocation.args, {
    cwd,
    stdio: 'inherit',
    timeout: 120_000,
  });
}
