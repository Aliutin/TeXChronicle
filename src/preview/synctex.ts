// Genuine inverse SyncTeX for the system LaTeX backend. The browser sends a
// page point in PDF big points (72 dpi, origin at the top left); the command-line
// parser supplied by TeX Live/MiKTeX resolves it to an input file and line.
//
// This module never shells out: every value is a separate execFile argument,
// and a returned input is accepted only when it resolves inside the project.
import { execFile } from 'node:child_process';
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

/** Turn SyncTeX's absolute/relative input into a safe project-relative path. */
export function projectRelativeInput(root: string, input: string): string | null {
  const base = resolve(root);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(base, input);
  const rel = relative(base, absolute);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export async function inverseSyncTeX(
  root: string,
  pdfPath: string,
  page: number,
  x: number,
  y: number,
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
  const file = projectRelativeInput(root, parsed.input);
  return file ? { file, line: parsed.line, ...(parsed.column === undefined ? {} : { column: parsed.column }) } : null;
}
