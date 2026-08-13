import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readmes = [path.join(packageRoot, 'README.md'), path.resolve(packageRoot, '..', 'README.md')];

const extractToolSection = (markdown: string): string => {
  const match = markdown.match(
    /<!-- gitnexus:mcp-tools:start -->([\s\S]*?)<!-- gitnexus:mcp-tools:end -->/,
  );
  expect(match, 'README must contain the generated MCP tool contract markers').not.toBeNull();
  return match![1];
};

describe('README MCP surface contract', () => {
  it.each(readmes)('%s documents exactly the tools exposed by the server', (readmePath) => {
    const markdown = fs.readFileSync(readmePath, 'utf-8');
    const section = extractToolSection(markdown);
    const documentedNames = [...section.matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1]);
    const exposedNames = GITNEXUS_TOOLS.map((tool) => tool.name);

    expect(new Set(documentedNames).size).toBe(documentedNames.length);
    expect(documentedNames.toSorted()).toEqual(exposedNames.toSorted());
    expect(markdown).toContain(`**${exposedNames.length} tools**`);
  });

  it('does not advertise removed group MCP tools', () => {
    for (const readmePath of readmes) {
      const section = extractToolSection(fs.readFileSync(readmePath, 'utf-8'));
      expect(section).not.toMatch(/group_(contracts|query|status)/);
    }
  });
});
