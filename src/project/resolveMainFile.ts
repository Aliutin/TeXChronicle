// Find the project's main .tex file: the one with \documentclass. If the caller
// gave an explicit path, trust it. If exactly one top-level candidate exists,
// use it. If several, refuse and list them rather than guessing wrong.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DOCUMENTCLASS = /^\s*\\documentclass/m;

export class MainFileError extends Error {}

export async function resolveMainFile(projectRoot: string, explicit?: string): Promise<string> {
  if (explicit) {
    // TeX tools accept `paper` as shorthand for `paper.tex`. Preserve that
    // convenience, but resolve it before compiling so render metadata and
    // semantic History identify the actual source file rather than falling
    // back to some unrelated conventional `main.tex` in the same directory.
    const normalized = explicit.replace(/\\/g, '/');
    const direct = await stat(join(projectRoot, normalized)).catch(() => null);
    if (direct?.isFile()) return normalized;
    if (!/\.tex$/i.test(normalized)) {
      const withExtension = `${normalized}.tex`;
      const candidate = await stat(join(projectRoot, withExtension)).catch(() => null);
      if (candidate?.isFile()) return withExtension;
    }
    return normalized;
  }

  let entries: string[];
  try {
    entries = (await readdir(projectRoot, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.tex'))
      .map((e) => e.name);
  } catch {
    throw new MainFileError(`Cannot read project directory: ${projectRoot}`);
  }

  if (entries.length === 0) {
    throw new MainFileError(`No .tex files found in ${projectRoot}. Pass "mainFile" explicitly if your main file is in a subdirectory.`);
  }

  const withDocClass: string[] = [];
  for (const name of entries) {
    const text = await readFile(join(projectRoot, name), 'utf8').catch(() => '');
    if (DOCUMENTCLASS.test(text)) withDocClass.push(name);
  }

  const candidates = withDocClass.length > 0 ? withDocClass : entries;
  // Prefer a conventional main.tex when multiple candidates tie.
  const main = candidates.find((n) => /^main\.tex$/i.test(n));
  if (main) return main;
  if (candidates.length === 1) return candidates[0];

  throw new MainFileError(
    `Multiple candidate main files found (${candidates.join(', ')}). ` +
      `Pass "mainFile" to pick one.`,
  );
}
