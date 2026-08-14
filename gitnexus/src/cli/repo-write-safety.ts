import fs from 'fs/promises';
import path from 'path';

export type SafeRepoLeafKind = 'file' | 'directory' | 'either';

export const canonicalizeRepoRoot = async (repoPath: string): Promise<string> =>
  fs.realpath(repoPath);

export const assertSafeRepoRelativePath = async (
  canonicalRepoPath: string,
  relativePath: string,
  leafKind: SafeRepoLeafKind = 'file',
): Promise<void> => {
  if (path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`Unsafe repository write path: ${relativePath}`);
  }
  const target = path.resolve(canonicalRepoPath, relativePath);
  const relative = path.relative(canonicalRepoPath, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Repository write path escapes root: ${relativePath}`);
  }

  let cursor = canonicalRepoPath;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in repository write path: ${relativePath}`);
      }
      const isLeaf = index === segments.length - 1;
      if (!isLeaf && !stat.isDirectory()) {
        throw new Error(`Non-directory ancestor in repository write path: ${relativePath}`);
      }
      if (isLeaf && leafKind === 'file' && !stat.isFile()) {
        throw new Error(`Repository write target is not a regular file: ${relativePath}`);
      }
      if (isLeaf && leafKind === 'directory' && !stat.isDirectory()) {
        throw new Error(`Repository write target is not a directory: ${relativePath}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
};
