// Find the project's main .tex file: the one with \documentclass. If the caller
// gave an explicit path, verify it names a real file inside the project. If
// exactly one top-level candidate exists, use it. If several, refuse and list
// them rather than guessing wrong.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DOCUMENTCLASS = /^\s*\\documentclass/m;
// `subfiles` chapters and `standalone` figures carry a \documentclass of their
// own — that is the whole point of both packages — but neither is ever the
// document you meant to compile. Counting them as candidates turned every
// subfiles thesis and every folder of TikZ figures into "Multiple candidate main
// files" unless the real root happened to be named main.tex.
const SUBORDINATE_CLASS = /^\s*\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(?:subfiles|standalone)\s*\}/m;
// `% !TEX root = ../thesis.tex` — the editor convention for "this file is a
// chapter, compile that instead". Honoured because opening a chapter and being
// handed the chapter's own broken half-compile is never what the author wanted.
const TEX_ROOT = /^[ \t]*%[ \t]*!\s*TEX\s+root\s*=\s*(.+?)[ \t]*$/im;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.latex-preview', '.vscode', '__pycache__']);
// A guard on the search below, not a limit anyone should reach: it exists so a
// mistyped project root pointed at a home directory cannot walk forever.
const MAX_SEARCHED_DIRS = 2000;

/** How to say "pick one" to both audiences. The MCP tool takes a `mainFile`
 *  parameter; a CLI user types a positional argument and has no such thing, and
 *  telling them to pass one sent people looking for a flag that isn't there. */
const HOW_TO_CHOOSE = 'Choose one: texchronicle preview <file>.tex — or pass "mainFile" from an MCP client.';

export class MainFileError extends Error {}

export async function resolveMainFile(projectRoot: string, explicit?: string): Promise<string> {
  if (explicit) return resolveExplicit(projectRoot, explicit);

  let entries: string[];
  try {
    entries = (await readdir(projectRoot, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.tex'))
      .map((e) => e.name);
  } catch {
    throw new MainFileError(`Cannot read project directory: ${projectRoot}`);
  }

  if (entries.length === 0) {
    const nested = await findTexFiles(projectRoot);
    const withClass: string[] = [];
    for (const rel of nested) {
      if (DOCUMENTCLASS.test(await readTexSource(join(projectRoot, rel)))) withClass.push(rel);
    }
    const found = withClass.length ? `\n\nThese look like document roots: ${withClass.slice(0, 10).join(', ')}` : '';
    throw new MainFileError(
      `No .tex files found in ${projectRoot} itself.${found}\n\n${HOW_TO_CHOOSE}`,
    );
  }

  const withDocClass: string[] = [];
  const roots: string[] = [];
  const declaredRoots = new Map<string, string>();
  for (const name of entries) {
    const text = await readTexSource(join(projectRoot, name));
    const declared = await declaredRoot(projectRoot, name, text);
    if (declared) declaredRoots.set(name, declared);
    if (!DOCUMENTCLASS.test(text)) continue;
    withDocClass.push(name);
    if (!SUBORDINATE_CLASS.test(text)) roots.push(name);
  }

  // Three tiers, most trustworthy first. Falling all the way back to "every .tex
  // in the directory" is deliberate: a project where nothing declares a class is
  // broken in a way we should describe rather than guess our way around.
  const noneDeclareAClass = withDocClass.length === 0;
  const candidates = roots.length ? roots : withDocClass.length ? withDocClass : entries;

  // Prefer a conventional main.tex when multiple candidates tie.
  const main = candidates.find((n) => /^main\.tex$/i.test(n));
  if (main) return main;
  if (candidates.length === 1) return candidates[0];

  // Several candidates that all point at the same root are not a tie: the author
  // already answered this question in the files themselves.
  const pointedAt = new Set(candidates.map((c) => declaredRoots.get(c)).filter(Boolean) as string[]);
  if (pointedAt.size === 1) {
    const only = [...pointedAt][0];
    if (candidates.every((c) => c === only || declaredRoots.get(c) === only)) return only;
  }

  if (noneDeclareAClass) {
    throw new MainFileError(
      `None of the .tex files in ${projectRoot} contain \\documentclass (${candidates.join(', ')}) — ` +
        `one of them has to be the document root, or its preamble lives somewhere we did not look. ${HOW_TO_CHOOSE}`,
    );
  }
  throw new MainFileError(`Multiple candidate main files found (${candidates.join(', ')}). ${HOW_TO_CHOOSE}`);
}

/**
 * An explicitly named main file, checked before it is believed.
 *
 * Every one of these used to be returned verbatim: an absolute path from another
 * project, `../sibling/main.tex`, a name with a typo in it. `join(root, 'C:/x/
 * main.tex')` on Windows produces a path that is not merely wrong but nonsense,
 * and the compile then quietly proceeded with an empty source — pdflatex, no
 * bibliography — and reported success over a PDF with `[?]` where the citations
 * should be. A name we cannot resolve inside the project has to be an error.
 */
async function resolveExplicit(projectRoot: string, explicit: string): Promise<string> {
  const normalized = explicit.replace(/\\/g, '/').trim();
  if (isAbsolute(normalized) || /^[a-zA-Z]:[\\/]/.test(normalized)) {
    throw new MainFileError(
      `The main file must be a path inside the project, not an absolute one: ${explicit}\n\n` +
        `The project here is ${projectRoot}. Either name the file relative to it, or point the project at the other directory.`,
    );
  }
  if (normalized.split('/').includes('..')) {
    throw new MainFileError(
      `The main file must stay inside the project: ${explicit}\n\n` +
        `The project here is ${projectRoot}. A path that climbs out of it would compile a document the project does not contain.`,
    );
  }

  const found = await locate(projectRoot, normalized);
  if (!found) {
    throw new MainFileError(`Main file not found in the project: ${explicit}\n\nLooked under ${projectRoot}. ${HOW_TO_CHOOSE}`);
  }
  // Opening a chapter has to compile the book. The chapter says which one.
  const declared = await declaredRoot(projectRoot, found, await readTexSource(join(projectRoot, found)));
  return declared ?? found;
}

/** The named file, the same name with `.tex` appended (TeX tools accept `paper`
 *  as shorthand for `paper.tex`), or — for a bare name whose file turns out to
 *  live in a subdirectory — the one place in the tree it actually is. */
async function locate(projectRoot: string, normalized: string): Promise<string | undefined> {
  const spellings = /\.tex$/i.test(normalized) ? [normalized] : [normalized, `${normalized}.tex`];
  for (const candidate of spellings) {
    const info = await stat(join(projectRoot, candidate)).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  const tree = await findTexFiles(projectRoot);
  for (const candidate of spellings) {
    // Shortest first, so `main.tex` prefers `paper/main.tex` over
    // `paper/appendix/drafts/main.tex` when a project has more than one.
    const hits = tree.filter((p) => p === candidate || p.endsWith('/' + candidate))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    if (hits.length) return hits[0];
  }
  return undefined;
}

/** The `% !TEX root` this file declares, as a project-relative path — or
 *  undefined when it declares none, names itself, points outside the project, or
 *  names something that isn't there. */
async function declaredRoot(projectRoot: string, fileRel: string, text: string): Promise<string | undefined> {
  const declared = TEX_ROOT.exec(text)?.[1];
  if (!declared) return undefined;
  const target = insideRoot(projectRoot, resolve(projectRoot, dirname(fileRel), declared.replace(/\\/g, '/')));
  if (!target || target === fileRel) return undefined;
  const info = await stat(join(projectRoot, target)).catch(() => null);
  return info?.isFile() ? target : undefined;
}

function insideRoot(projectRoot: string, absolute: string): string | undefined {
  const rel = relative(resolve(projectRoot), absolute);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** Every .tex in the project, project-relative and posix-separated. */
async function findTexFiles(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  let visited = 0;
  const walk = async (dir: string): Promise<void> => {
    if (visited++ > MAX_SEARCHED_DIRS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.tex')) {
        out.push(relative(projectRoot, full).split(sep).join('/'));
      }
    }
  };
  await walk(projectRoot);
  return out;
}

/**
 * Read a .tex file as text whatever its encoding.
 *
 * A UTF-16 source — what a Windows editor writes when someone picks "Unicode" —
 * read as UTF-8 is a string of interleaved NULs, and `\documentclass` is not in
 * it. The file then failed to be recognised as the document root of its own
 * project, and the user was told to choose between it and their notes file.
 */
async function readTexSource(path: string): Promise<string> {
  const buf = await readFile(path).catch(() => null);
  if (!buf) return '';
  if (buf.length >= 2 && buf.length % 2 === 0) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return stripBom(buf.toString('utf16le'));
    // Big-endian: Buffer only decodes LE, so swap the pairs first.
    if (buf[0] === 0xfe && buf[1] === 0xff) return stripBom(Buffer.from(buf).swap16().toString('utf16le'));
  }
  return stripBom(buf.toString('utf8'));
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
