import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  GITNEXUS_REPO_SKILLS,
  MANAGED_SKILLS_MARKER_FILE,
  generateAIContextFiles,
} from './ai-context.js';
import { discoverGeneratedSkills, type GeneratedSkillInfo } from './skill-gen.js';
import { assertSafeRepoRelativePath, canonicalizeRepoRoot } from './repo-write-safety.js';

export type AgentContextChangeAction = 'create' | 'update' | 'unchanged';

export interface AgentContextChange {
  relativePath: string;
  action: AgentContextChangeAction;
  before: string | null;
  after: string;
  beforeHash: string | null;
  afterHash: string;
  diff: string;
}

export interface AgentContextPlan {
  schema: 1;
  repoPath: string;
  projectName: string;
  planId: string;
  changes: AgentContextChange[];
}

const AGENT_CONTEXT_PLAN_SCHEMA = 1 as const;
const issuedPlans = new WeakSet<AgentContextPlan>();

interface RepoStats {
  files?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  clusters?: number;
  processes?: number;
}

const hashContent = (content: string): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

const readFileOrNull = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const createUnifiedDiff = (relativePath: string, before: string | null, after: string): string => {
  if (before === after) return '';
  const oldLines = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const newLines = after.replace(/\n$/, '').split('\n');
  const oldHeader = before === null ? '/dev/null' : `a/${relativePath}`;
  return [
    `--- ${oldHeader}`,
    `+++ b/${relativePath}`,
    `@@ -${oldLines.length === 0 ? '0,0' : `1,${oldLines.length}`} +${
      newLines.length === 0 ? '0,0' : `1,${newLines.length}`
    } @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '',
  ].join('\n');
};

export const declaredAgentContextTargets = (): string[] => [
  'AGENTS.md',
  ...GITNEXUS_REPO_SKILLS.map(({ name }) => `.agents/skills/${name}/SKILL.md`),
  `.agents/skills/${MANAGED_SKILLS_MARKER_FILE}`,
];

const buildPlanId = (
  repoPath: string,
  projectName: string,
  changes: AgentContextChange[],
): string => {
  const payload = JSON.stringify({
    schema: AGENT_CONTEXT_PLAN_SCHEMA,
    repoPath,
    projectName,
    changes: changes.map(({ relativePath, beforeHash, afterHash }) => ({
      relativePath,
      beforeHash,
      afterHash,
    })),
  });
  return hashContent(payload);
};

export const assertIssuedAgentContextPlan = async (plan: AgentContextPlan): Promise<void> => {
  if (!issuedPlans.has(plan) || plan.schema !== AGENT_CONTEXT_PLAN_SCHEMA) {
    throw new Error('Agent-context apply requires a plan issued by planAIContextFiles.');
  }
  if ((await canonicalizeRepoRoot(plan.repoPath)) !== plan.repoPath) {
    throw new Error('Agent-context plan root is not canonical.');
  }
  for (const change of plan.changes) {
    const expectedBeforeHash = change.before === null ? null : hashContent(change.before);
    const expectedAfterHash = hashContent(change.after);
    const expectedAction: AgentContextChangeAction =
      change.before === null ? 'create' : change.before === change.after ? 'unchanged' : 'update';
    if (
      change.beforeHash !== expectedBeforeHash ||
      change.afterHash !== expectedAfterHash ||
      change.action !== expectedAction
    ) {
      throw new Error(`Agent-context plan content was modified: ${change.relativePath}`);
    }
  }
  if (plan.planId !== buildPlanId(plan.repoPath, plan.projectName, plan.changes)) {
    throw new Error('Agent-context plan ID does not match its content.');
  }
};

export const planAIContextFiles = async (
  repoPath: string,
  storagePath: string,
  projectName: string,
  stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[],
): Promise<AgentContextPlan> => {
  const canonicalRoot = await canonicalizeRepoRoot(repoPath);
  const targets = declaredAgentContextTargets();
  for (const relativePath of targets) {
    await assertSafeRepoRelativePath(canonicalRoot, relativePath);
  }

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-agent-context-plan-'));
  try {
    const existingAgents = await readFileOrNull(path.join(canonicalRoot, 'AGENTS.md'));
    if (existingAgents !== null) {
      await fs.writeFile(path.join(stagingRoot, 'AGENTS.md'), existingAgents, 'utf-8');
    }

    const routedGeneratedSkills = generatedSkills ?? (await discoverGeneratedSkills(canonicalRoot));
    await generateAIContextFiles(
      stagingRoot,
      storagePath,
      projectName,
      stats,
      routedGeneratedSkills,
      { noStats: true },
    );

    const changes: AgentContextChange[] = [];
    for (const relativePath of targets) {
      const absolutePath = path.join(canonicalRoot, relativePath);
      const before = await readFileOrNull(absolutePath);
      const after = await fs.readFile(path.join(stagingRoot, relativePath), 'utf-8');
      changes.push({
        relativePath,
        action: before === null ? 'create' : before === after ? 'unchanged' : 'update',
        before,
        after,
        beforeHash: before === null ? null : hashContent(before),
        afterHash: hashContent(after),
        diff: createUnifiedDiff(relativePath, before, after),
      });
    }

    const plan: AgentContextPlan = {
      schema: AGENT_CONTEXT_PLAN_SCHEMA,
      repoPath: canonicalRoot,
      projectName,
      planId: '',
      changes,
    };
    plan.planId = buildPlanId(canonicalRoot, projectName, changes);
    issuedPlans.add(plan);
    return plan;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
};
