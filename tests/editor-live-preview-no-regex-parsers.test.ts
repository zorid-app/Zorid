import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const productionRoots = ['packages/editor/src/live-preview'];
const futureParserModuleRoots = ['packages/editor/src/live-preview', 'packages/editor/src/markdown'];
const parserAdjacentFiles = ['packages/editor/src/indentation.ts', 'packages/editor/src/markdown-list-commands.ts'];
const allowedRendererApiMethod = 'match(context)';

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      if (entry.isFile() && path.endsWith('.ts')) files.push(path);
    }
  }
  await walk(root);
  return files;
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\.|[^`])*`/g, '``')
    .replace(/'(?:\\.|[^'])*'/g, "''")
    .replace(/"(?:\\.|[^"])*"/g, '""');
}

function forbiddenParserTokens(source: string): string[] {
  const stripped = stripCommentsAndStrings(source);
  const findings: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ['RegExp constructor/type', /\bRegExp\b/],
    ['String.matchAll parser scan', /\.matchAll\s*\(/],
    ['RegExp.exec parser scan', /\.exec\s*\(/],
    ['regex literal parser', /(^|[=(:,[!&|?{};]|\breturn\s+)\s*\/(?![/*])(?:\\.|[^/\n])+\/[dgimsuvy]*/m],
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(stripped)) findings.push(label);
  }
  if (stripped.includes('.match(') && !source.includes(allowedRendererApiMethod)) {
    findings.push('String.match parser scan');
  }
  return findings;
}

describe('Live Preview parser ownership', () => {
  it('keeps production Live Preview parser recognition free of regex scanners', async () => {
    const files = (await Promise.all(productionRoots.map(sourceFiles))).flat();
    const failures: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const findings = forbiddenParserTokens(source);
      if (findings.length > 0) failures.push(`${relative(process.cwd(), file)}: ${findings.join(', ')}`);
    }

    expect(failures).toEqual([]);
  });

  it('extends the no-regex parser gate to private Markdown parser-extension modules', async () => {
    const files = (await Promise.all(futureParserModuleRoots.map(sourceFiles))).flat();
    const parserExtensionFiles = files.filter((file) => /markdown|syntax|parser|language|extension/.test(file));
    const failures: string[] = [];

    for (const file of parserExtensionFiles) {
      const source = await readFile(file, 'utf8');
      const findings = forbiddenParserTokens(source);
      if (findings.length > 0) failures.push(`${relative(process.cwd(), file)}: ${findings.join(', ')}`);
    }

    expect(failures).toEqual([]);
  });

  it('keeps parser-adjacent editor command helpers free of regex scanners', async () => {
    const failures: string[] = [];

    for (const file of parserAdjacentFiles) {
      const source = await readFile(file, 'utf8');
      const findings = forbiddenParserTokens(source);
      if (findings.length > 0) failures.push(`${file}: ${findings.join(', ')}`);
    }

    expect(failures).toEqual([]);
  });
});
