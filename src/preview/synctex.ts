// Genuine inverse SyncTeX for the system LaTeX backend. The browser sends a
// page point in PDF big points (72 dpi, origin at the top left); the command-line
// parser supplied by TeX Live/MiKTeX resolves it to an input file and line.
//
// This module never shells out: every value is a separate execFile argument,
// and a returned input is accepted only when it resolves inside the project.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface SyncTeXSourceLocation {
  file: string;
  line: number;
  column?: number;
}

/** Parse the first result emitted by `synctex edit`. Exported for fixtures. */
export function parseSyncTeXEdit(output: string): { input: string; line: number; column?: number } | null {
  const block = output.match(/SyncTeX result begin([\s\S]*?)SyncTeX result end/i)?.[1];
  if (!block) return null;
  const input = block.match(/^Input:(.*)$/mi)?.[1]?.trim();
  const line = Number(block.match(/^Line:\s*(-?\d+)/mi)?.[1]);
  const rawColumn = Number(block.match(/^Column:\s*(-?\d+)/mi)?.[1]);
  if (!input || !Number.isInteger(line) || line < 1) return null;
  return { input, line, ...(Number.isInteger(rawColumn) && rawColumn >= 0 ? { column: rawColumn } : {}) };
}

/**
 * Turn SyncTeX's absolute/relative input into a safe project-relative path.
 *
 * `mainDir` is the main file's own directory, project-relative — the directory
 * the compile actually ran in, because latexmk is invoked with `-cd`. It matters
 * only for the relative case, and there it is the whole answer: a paper whose
 * root is `paper/main.tex` records its chapters as `sections/body.tex`, and
 * resolving that against the project root yields `<root>/sections/body.tex`,
 * which does not exist. The guard below then rejects it and a PDF click returns
 * nothing at all, silently — the viewer just does not jump, and nothing anywhere
 * says why.
 *
 * MiKTeX writes absolute paths and never reaches this; TeX Live is reported to
 * write them relative to the engine's working directory. Both are handled by
 * trying the compile directory first and the project root second, so a
 * distribution that means the other one still lands inside the project rather
 * than being thrown away.
 */
export function projectRelativeInput(root: string, input: string, mainDir = '.'): string | null {
  const base = resolve(root);
  const inside = (absolute: string): string | null => {
    const rel = relative(base, absolute);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  };
  if (isAbsolute(input)) return inside(resolve(input));
  return inside(resolve(base, mainDir, input)) ?? inside(resolve(base, input));
}

/** The candidate project-relative paths for a SyncTeX input, best guess first.
 *  Separated from the choice above so the caller can prefer one that is really
 *  on disk — two directories can both be inside the project, and only one of
 *  them holds the file. */
function inputCandidates(root: string, input: string, mainDir: string): string[] {
  const first = projectRelativeInput(root, input, mainDir);
  const second = projectRelativeInput(root, input, '.');
  return [...new Set([first, second].filter((path): path is string => path !== null))];
}

/**
 * `mainDir` defaults to the project root, which is what every caller meant
 * before nested main files were compiled with `-cd`. Passing the main file's
 * directory is what makes a relative SyncTeX record resolve correctly; passing
 * nothing keeps the previous behaviour exactly.
 */
export async function inverseSyncTeX(
  root: string,
  pdfPath: string,
  page: number,
  x: number,
  y: number,
  mainDir = '.',
): Promise<SyncTeXSourceLocation | null> {
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  const query = `${page}:${x.toFixed(3)}:${y.toFixed(3)}:${pdfPath}`;
  let stdout = '';
  try {
    const result = await pexec('synctex', ['edit', '-o', query], {
      cwd: root, windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    });
    stdout = result.stdout;
  } catch (error) {
    // Some distributions return non-zero while still printing a usable result;
    // parse it before falling back. Missing command/index simply yields null.
    const out = (error as { stdout?: string | Buffer }).stdout;
    stdout = typeof out === 'string' ? out : out?.toString('utf8') ?? '';
  }
  const parsed = parseSyncTeXEdit(stdout);
  if (!parsed) return null;
  const candidates = inputCandidates(root, parsed.input, mainDir);
  if (!candidates.length) return null;
  // Where two readings are both inside the project, the one that exists wins.
  // Guessing here is cheap and being wrong is not: the editor would scroll to a
  // line in a file the reader never clicked on.
  const onDisk = await firstExisting(root, candidates);
  const file = onDisk ?? candidates[0];
  return { file, line: parsed.line, ...(parsed.column === undefined ? {} : { column: parsed.column }) };
}

async function firstExisting(root: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await access(resolve(root, candidate)).then(() => true, () => false)) return candidate;
  }
  return undefined;
}
