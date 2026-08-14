import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  assertIssuedAgentContextPlan,
  declaredAgentContextTargets,
  type AgentContextChange,
  type AgentContextPlan,
} from './agent-context-plan.js';
import { assertSafeRepoRelativePath } from './repo-write-safety.js';

export class AgentContextConflictError extends Error {
  constructor(public readonly paths: string[]) {
    super(`Agent context changed after planning: ${paths.join(', ')}`);
    this.name = 'AgentContextConflictError';
  }
}

const readOptionalFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const ensureSafeParentDirectories = async (repoPath: string, targetPath: string): Promise<void> => {
  const parent = path.dirname(targetPath);
  const relative = path.relative(repoPath, parent);
  let cursor = repoPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe agent-context directory: ${cursor}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(cursor);
    }
  }
};

const atomicWrite = async (
  plan: AgentContextPlan,
  change: AgentContextChange,
): Promise<'written' | 'unchanged'> => {
  const targetPath = path.join(plan.repoPath, change.relativePath);
  await assertSafeRepoRelativePath(plan.repoPath, change.relativePath);
  await ensureSafeParentDirectories(plan.repoPath, targetPath);

  const current = await readOptionalFile(targetPath);
  if (current === change.after) return 'unchanged';
  if (current !== change.before) throw new AgentContextConflictError([change.relativePath]);

  const parent = path.dirname(targetPath);
  const tempPath = path.join(parent, `.gitnexus-context-${process.pid}-${randomUUID()}.tmp`);
  const mode = current === null ? 0o644 : (await fs.lstat(targetPath)).mode & 0o777 || 0o644;
  try {
    await fs.writeFile(tempPath, change.after, { encoding: 'utf-8', flag: 'wx', mode });
    await assertSafeRepoRelativePath(plan.repoPath, change.relativePath);
    const beforeRename = await readOptionalFile(targetPath);
    if (beforeRename === change.after) return 'unchanged';
    if (beforeRename !== change.before) {
      throw new AgentContextConflictError([change.relativePath]);
    }
    await fs.rename(tempPath, targetPath);
    return 'written';
  } finally {
    await fs.rm(tempPath, { force: true });
  }
};

export const applyAIContextPlan = async (
  plan: AgentContextPlan,
): Promise<{ written: string[]; unchanged: string[] }> => {
  await assertIssuedAgentContextPlan(plan);
  const declared = new Set(declaredAgentContextTargets());
  const seen = new Set<string>();
  const conflicts: string[] = [];
  const pending: AgentContextChange[] = [];
  const unchanged: string[] = [];

  for (const change of plan.changes) {
    if (!declared.has(change.relativePath) || seen.has(change.relativePath)) {
      throw new Error(`Invalid agent-context plan target: ${change.relativePath}`);
    }
    seen.add(change.relativePath);
    const targetPath = path.join(plan.repoPath, change.relativePath);
    await assertSafeRepoRelativePath(plan.repoPath, change.relativePath);
    const current = await readOptionalFile(targetPath);
    if (current === change.after) unchanged.push(change.relativePath);
    else if (current === change.before) pending.push(change);
    else conflicts.push(change.relativePath);
  }

  if (seen.size !== declared.size) throw new Error('Agent-context plan omits declared targets');
  if (conflicts.length > 0) throw new AgentContextConflictError(conflicts);

  const marker = '.agents/skills/.gitnexus-managed-commit';
  pending.sort((a, b) => Number(a.relativePath === marker) - Number(b.relativePath === marker));
  const written: string[] = [];
  for (const change of pending) {
    const outcome = await atomicWrite(plan, change);
    if (outcome === 'written') written.push(change.relativePath);
    else unchanged.push(change.relativePath);
  }
  return { written, unchanged };
};
