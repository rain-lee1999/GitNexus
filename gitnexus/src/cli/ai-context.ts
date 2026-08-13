/**
 * AI Context Generator
 *
 * Creates AGENTS.md with inline GitNexus context and installs repo-scoped
 * Codex skills under .agents/skills/.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { type GeneratedSkillInfo } from './skill-gen.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RepoStats {
  files?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  clusters?: number; // Aggregated cluster count (what tools show)
  processes?: number;
}

export interface AIContextOptions {
  skipAgentsMd?: boolean;
  noStats?: boolean;
}

const GITNEXUS_START_MARKER = '<!-- gitnexus:start -->';
const GITNEXUS_END_MARKER = '<!-- gitnexus:end -->';
const GITNEXUS_CONTEXT_VERSION_MARKER = '<!-- gitnexus:context-version:1 -->';
const MANAGED_SKILLS_COMMIT_FILE = '.gitnexus-managed-commit';

export const GITNEXUS_REPO_SKILLS = [
  {
    name: 'gitnexus-exploring',
    description:
      'Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: "How does X work?", "What calls this function?", "Show me the auth flow"',
  },
  {
    name: 'gitnexus-debugging',
    description:
      'Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: "Why is X failing?", "Where does this error come from?", "Trace this bug"',
  },
  {
    name: 'gitnexus-impact-analysis',
    description:
      'Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: "Is it safe to change X?", "What depends on this?", "What will break?"',
  },
  {
    name: 'gitnexus-refactoring',
    description:
      'Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: "Rename this function", "Extract this into a module", "Refactor this class", "Move this to a separate file"',
  },
  {
    name: 'gitnexus-pr-review',
    description:
      'Use when reviewing a pull request or code changes and you need impact analysis, regression risk, or call-graph context. Examples: "Review this PR", "Check these changes", "What could regress?"',
  },
  {
    name: 'gitnexus-guide',
    description:
      'Use when the user asks about GitNexus itself — available tools, how to query the knowledge graph, MCP resources, graph schema, or workflow reference. Examples: "What GitNexus tools are available?", "How do I use GitNexus?"',
  },
  {
    name: 'gitnexus-cli',
    description:
      'Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: "Index this repo", "Reanalyze the codebase", "Generate a wiki"',
  },
] as const;

async function readIndexedCommit(storagePath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(storagePath, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw) as { lastCommit?: unknown };
    return typeof meta.lastCommit === 'string' && meta.lastCommit.length > 0
      ? meta.lastCommit
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the index of a section marker that occupies its own line.
 * Unlike `indexOf`, this rejects inline prose references like
 * `` See the `<!-- gitnexus:start -->` block `` that appear
 * mid-sentence (#1041). A marker counts as section-position only when:
 *   - preceded by newline or start-of-file, AND
 *   - followed by newline, `\r` (CRLF files), or end-of-file.
 * The generator always emits each marker alone on its line, so this
 * matches every legitimate section and none of the inline mentions.
 *
 * `startFrom` lets the end-marker lookup start after the already-found
 * start marker, avoiding a scan from 0 and guaranteeing we never pick
 * up an end marker that appears earlier in the file than the start.
 */
function findSectionMarkerIndex(content: string, marker: string, startFrom = 0): number {
  let idx = content.indexOf(marker, startFrom);
  while (idx !== -1) {
    const atLineStart = idx === 0 || content[idx - 1] === '\n';
    const endPos = idx + marker.length;
    const atLineEnd =
      endPos === content.length || content[endPos] === '\n' || content[endPos] === '\r';
    if (atLineStart && atLineEnd) return idx;
    idx = content.indexOf(marker, idx + 1);
  }
  return -1;
}

/**
 * Generate the full GitNexus context content.
 *
 * Design principles (learned from real agent behavior and industry research):
 * - Inline critical workflows — skills are skipped 56% of the time (Vercel eval data)
 * - Use RFC 2119 language (MUST, NEVER, ALWAYS) — models follow imperative rules
 * - Three-tier boundaries (Always/When/Never) — proven to change model behavior
 * - Keep under 120 lines — adherence degrades past 150 lines
 * - Exact tool commands with parameters — vague directives get ignored
 * - Self-review checklist — forces model to verify its own work
 */
async function findGroupsContainingRegistryName(registryName: string): Promise<string[]> {
  const { listGroups, getDefaultGitnexusDir, getGroupDir } =
    await import('../core/group/storage.js');
  const { loadGroupConfig } = await import('../core/group/config-parser.js');
  const names = await listGroups();
  const hits: string[] = [];
  for (const g of names) {
    try {
      const config = await loadGroupConfig(getGroupDir(getDefaultGitnexusDir(), g));
      if (Object.values(config.repos).some((r) => r === registryName)) hits.push(config.name);
    } catch {
      // skip invalid or unreadable groups
    }
  }
  return hits;
}

function generateGitNexusContent(
  projectName: string,
  stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[],
  groupNames?: string[],
  noStats?: boolean,
): string {
  const generatedRows =
    generatedSkills && generatedSkills.length > 0
      ? generatedSkills
          .map(
            (s) =>
              `| Work in the ${s.label} area (${s.symbolCount} symbols) | \`.agents/skills/${s.name}/SKILL.md\` |`,
          )
          .join('\n')
      : '';

  const skillsTable = `| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | \`.agents/skills/gitnexus-exploring/SKILL.md\` |
| Blast radius / "What breaks if I change X?" | \`.agents/skills/gitnexus-impact-analysis/SKILL.md\` |
| Trace bugs / "Why is X failing?" | \`.agents/skills/gitnexus-debugging/SKILL.md\` |
| Rename / extract / split / refactor | \`.agents/skills/gitnexus-refactoring/SKILL.md\` |
| Review a pull request or code changes | \`.agents/skills/gitnexus-pr-review/SKILL.md\` |
| Tools, resources, schema reference | \`.agents/skills/gitnexus-guide/SKILL.md\` |
| Index, status, clean, wiki CLI commands | \`.agents/skills/gitnexus-cli/SKILL.md\` |${generatedRows ? '\n' + generatedRows : ''}`;

  return `${GITNEXUS_START_MARKER}
${GITNEXUS_CONTEXT_VERSION_MARKER}
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **${projectName}**${noStats ? '' : ` (${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows)`}. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Graph stale/missing: \`status\` → read-only \`plan\` → only with writable targets/scoped approval \`gitnexus refresh ensure --path <absolute-worktree>\`. Index-only writes \`.gitnexus/\`, Git metadata, and \`GITNEXUS_HOME\`; else stale graph + source. Use absolute \`repo\`. \`detect_changes\` is not freshness-gated.

## Always Do

- **MUST run impact analysis before editing any symbol.** Run \`gitnexus_impact({target: "symbolName", direction: "upstream", repo: "<absolute-worktree>"})\`, then report its blast radius.
- **MUST run \`gitnexus_detect_changes()\` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- For unfamiliar code, use \`gitnexus_query({query: "concept", repo: "<absolute-worktree>"})\` to find execution flows.
- For a symbol's callers, callees, and flows, use \`gitnexus_context({name: "symbolName", repo: "<absolute-worktree>"})\`.

## Never Do

- NEVER edit a function, class, or method without first running \`gitnexus_impact\` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use \`gitnexus_rename\` which understands the call graph.
- NEVER commit changes without running \`gitnexus_detect_changes()\` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| \`gitnexus://repo/${projectName}/context\` | Codebase overview, check index freshness |
| \`gitnexus://repo/${projectName}/clusters\` | All functional areas |
| \`gitnexus://repo/${projectName}/processes\` | All execution flows |
| \`gitnexus://repo/${projectName}/process/{name}\` | Step-by-step execution trace |

${
  groupNames && groupNames.length > 0
    ? `## Cross-Repo Groups

This repository is listed under GitNexus **group(s): ${groupNames.join(', ')}** (see \`~/.gitnexus/groups/\`). For cross-repo analysis, use MCP tools \`impact\`, \`query\`, and \`context\` with \`repo\` set to \`@<groupName>\` or \`@<groupName>/<memberPath>\` (paths match keys in that group’s \`group.yaml\`). Use \`group_list\` / \`group_sync\` for membership and sync. From the terminal: \`npx gitnexus group list\`, \`npx gitnexus group sync <name>\`, \`npx gitnexus group impact <name> --target <symbol> --repo <group-path>\`.

`
    : ''
}## CLI

${skillsTable}

${GITNEXUS_END_MARKER}`;
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or update GitNexus section in a file
 * - If file doesn't exist: create with GitNexus content
 * - If file exists without GitNexus section: append
 * - If file exists with GitNexus section: replace that section
 */
async function upsertGitNexusSection(
  filePath: string,
  content: string,
): Promise<'created' | 'updated' | 'appended'> {
  const exists = await fileExists(filePath);

  if (!exists) {
    await fs.writeFile(filePath, content.trim() + '\n', 'utf-8');
    return 'created';
  }

  const existingContent = await fs.readFile(filePath, 'utf-8');

  // Check if GitNexus section already exists. Matching is restricted
  // to markers that occupy their own line so that inline prose
  // references (e.g. `` See the `<!-- gitnexus:start -->` block ``) are
  // NOT treated as section delimiters (#1041). The end-marker scan starts
  // after the start-marker so it can never pick up an earlier end.
  const startIdx = findSectionMarkerIndex(existingContent, GITNEXUS_START_MARKER);
  const endIdx = findSectionMarkerIndex(
    existingContent,
    GITNEXUS_END_MARKER,
    startIdx === -1 ? 0 : startIdx,
  );

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing section
    const before = existingContent.substring(0, startIdx);
    const after = existingContent.substring(endIdx + GITNEXUS_END_MARKER.length);
    const newContent = before + content + after;
    await fs.writeFile(filePath, newContent.trim() + '\n', 'utf-8');
    return 'updated';
  }

  // Append new section
  const newContent = existingContent.trim() + '\n\n' + content + '\n';
  await fs.writeFile(filePath, newContent, 'utf-8');
  return 'appended';
}

/**
 * Install GitNexus skills as direct children of .agents/skills/ so Codex can
 * discover each SKILL.md natively. Only GitNexus-owned directories are touched.
 */
async function installSkills(repoPath: string, indexedCommit?: string): Promise<string[]> {
  const skillsDir = path.join(repoPath, '.agents', 'skills');
  const installedSkills: string[] = [];

  await fs.mkdir(skillsDir, { recursive: true });
  await fs.rm(path.join(skillsDir, MANAGED_SKILLS_COMMIT_FILE), { force: true });

  for (const skill of GITNEXUS_REPO_SKILLS) {
    const skillName = skill.name;
    const skillDir = path.join(skillsDir, skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      // Create skill directory
      await fs.mkdir(skillDir, { recursive: true });

      // Try to read from package skills directory
      const packageSkillPath = path.join(__dirname, '..', '..', 'skills', `${skillName}.md`);
      let skillContent: string;

      try {
        skillContent = await fs.readFile(packageSkillPath, 'utf-8');
      } catch {
        // Fallback: generate minimal skill content
        skillContent = `---
name: ${skillName}
description: ${skill.description}
---

# ${skillName.charAt(0).toUpperCase() + skillName.slice(1)}

${skill.description}

Use GitNexus tools to accomplish this task.
`;
      }

      await fs.writeFile(skillPath, skillContent, 'utf-8');
      installedSkills.push(skillName);
    } catch (err) {
      // Skip on error, don't fail the whole process
      console.warn(`Warning: Could not install skill ${skillName}:`, err);
    }
  }

  if (installedSkills.length === GITNEXUS_REPO_SKILLS.length) {
    await fs.writeFile(
      path.join(skillsDir, MANAGED_SKILLS_COMMIT_FILE),
      `${indexedCommit ?? 'unknown'}\n`,
      'utf-8',
    );
  }

  return installedSkills;
}

/**
 * Generate AI context files after indexing
 */
export async function generateAIContextFiles(
  repoPath: string,
  storagePath: string,
  projectName: string,
  stats: RepoStats,
  generatedSkills?: GeneratedSkillInfo[],
  options?: AIContextOptions,
): Promise<{ files: string[] }> {
  const indexedCommit = await readIndexedCommit(storagePath);
  const groupNames = await findGroupsContainingRegistryName(projectName);
  const content = generateGitNexusContent(
    projectName,
    stats,
    generatedSkills,
    groupNames,
    options?.noStats,
  );
  const createdFiles: string[] = [];

  if (!options?.skipAgentsMd) {
    // Create AGENTS.md (Codex's repository instruction file).
    const agentsPath = path.join(repoPath, 'AGENTS.md');
    const agentsResult = await upsertGitNexusSection(agentsPath, content);
    createdFiles.push(`AGENTS.md (${agentsResult})`);
  } else {
    createdFiles.push('AGENTS.md (skipped via --skip-agents-md)');
  }

  // Install repo-scoped skills to .agents/skills/.
  const installedSkills = await installSkills(repoPath, indexedCommit);
  if (installedSkills.length > 0) {
    createdFiles.push(`.agents/skills/ (${installedSkills.length} GitNexus skills)`);
  }

  return { files: createdFiles };
}
