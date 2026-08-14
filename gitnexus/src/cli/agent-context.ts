import fs from 'fs/promises';
import path from 'path';
import { getGitRoot } from '../storage/git.js';
import {
  getIndexHealth,
  getStoragePaths,
  loadMeta,
  withAnalysisLock,
} from '../storage/repo-manager.js';
import { getContextProjectName } from '../core/run-analyze.js';
import { assertSafeContextProjectName } from './ai-context.js';
import { planAIContextFiles, type AgentContextPlan } from './agent-context-plan.js';
import { applyAIContextPlan } from './agent-context-apply.js';

type AgentContextAction = 'plan' | 'apply';

export interface AgentContextCommandOptions {
  path?: string;
  name?: string;
  json?: boolean;
  expect?: string;
}

const resolveWorktreeRoot = async (inputPath: string | undefined): Promise<string> => {
  if (!inputPath || !path.isAbsolute(inputPath)) {
    throw new Error('agent-context requires --path <absolute-worktree>');
  }
  const canonical = await fs.realpath(inputPath);
  const gitRoot = getGitRoot(canonical);
  if (!gitRoot || (await fs.realpath(gitRoot)) !== canonical) {
    throw new Error(`agent-context path must be an absolute Git worktree root: ${inputPath}`);
  }
  return canonical;
};

const printPlan = (plan: AgentContextPlan): void => {
  const changed = plan.changes.filter(({ action }) => action !== 'unchanged');
  console.log(`Agent context plan for ${plan.repoPath}`);
  console.log(`Plan ID: ${plan.planId}`);
  if (changed.length === 0) {
    console.log('No changes.');
    console.log('No repository files were written.');
    return;
  }
  for (const change of changed) {
    console.log(`\n${change.action.toUpperCase()} ${change.relativePath}`);
    console.log(change.diff);
  }
  console.log('\nNo repository files were written.');
};

export const agentContextCommand = async (
  actionInput: string,
  options: AgentContextCommandOptions = {},
): Promise<void> => {
  const action = actionInput as AgentContextAction;
  if (action !== 'plan' && action !== 'apply') {
    throw new Error(`Unknown agent-context action: ${actionInput}. Expected plan or apply.`);
  }
  if (action === 'apply' && !options.expect) {
    throw new Error('agent-context apply requires --expect <plan-id> from a reviewed plan.');
  }

  const repoPath = await resolveWorktreeRoot(options.path);
  const { storagePath } = getStoragePaths(repoPath);
  const projectName = options.name ?? getContextProjectName(repoPath);
  assertSafeContextProjectName(projectName);

  const buildCurrentPlan = async (): Promise<AgentContextPlan> => {
    const meta = await loadMeta(storagePath);
    if (!meta)
      throw new Error(`Repository is not indexed: ${repoPath}. Run gitnexus analyze first.`);
    const health = await getIndexHealth(repoPath);
    if (!health.ok) {
      throw new Error(`Repository index is not healthy: ${health.message ?? health.reason}`);
    }
    return planAIContextFiles(repoPath, storagePath, projectName, meta.stats ?? {});
  };

  const assertExpectedPlan = (plan: AgentContextPlan): void => {
    if (options.expect && options.expect !== plan.planId) {
      throw new Error(
        `Agent-context plan changed: expected ${options.expect}, current ${plan.planId}. Run plan again.`,
      );
    }
  };

  if (action === 'plan') {
    const plan = await buildCurrentPlan();
    assertExpectedPlan(plan);
    if (options.json) console.log(JSON.stringify(plan, null, 2));
    else printPlan(plan);
    return;
  }

  // Lock the complete apply transaction, including regenerated desired-state
  // discovery. Otherwise a concurrent legacy `analyze --skills` could change
  // generated-skill inputs after --expect was checked but before writes begin.
  const { plan, result } = await withAnalysisLock(repoPath, async () => {
    const lockedPlan = await buildCurrentPlan();
    assertExpectedPlan(lockedPlan);
    return { plan: lockedPlan, result: await applyAIContextPlan(lockedPlan) };
  });
  if (options.json) {
    console.log(JSON.stringify({ repoPath, planId: plan.planId, ...result }, null, 2));
  } else {
    console.log(`Applied agent context: ${repoPath}`);
    console.log(`Written: ${result.written.length}; unchanged: ${result.unchanged.length}`);
  }
};
