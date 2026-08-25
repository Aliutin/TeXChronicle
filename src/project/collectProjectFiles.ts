// Gather the project's compile inputs into the engine's file format.
//
// Design choice: rather than precisely following \input/\include chains (fragile
// with nested/relative/extensionless includes), we collect the whole project
// tree of relevant file types. That's what a real compile needs anyway and
// mirrors how Overleaf sees the full project. In-repo .cls/.sty/.bst are picked
// up automatically this way (e.g. acl.sty, llncs.cls), which the engine's bundled
// package set may not include.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { EngineFile } from '../engine/browserHost.js';

// Everything TeX reads as text. Wider than it looks it needs to be, because a
// missing extension is invisible: the file is simply absent at compile time and
// LaTeX reports something unrelated. `.bbl` is how arXiv sources ship their
// bibliography, `.txt`/`.csv`/`.dat`/`.tsv` are what pgfplots and \input pull in,
// `.pdf_tex` is Inkscape's LaTeX-overlay half of an exported figure, and
// `.bcf`/`.glo`/`.nls`/`.ist`/`.gst` are the auxiliary tool inputs.
const TEXT_EXT = new Set([
  '.tex', '.bib', '.cls', '.sty', '.bst', '.cfg', '.clo', '.def', '.ldf', '.fd', '.bbx', '.cbx', '.lbx',
  '.bbl', '.ist', '.gst', '.glo', '.nls', '.bcf', '.txt', '.csv', '.dat', '.tsv', '.pdf_tex', '.pgf',
  '.tikz', '.ltx', '.lua', '.inc',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.ttf', '.otf', '.gif',
  // Font and image formats a real paper ships when it carries its own fonts or
  // scanned figures. Absent from the engine, a font file is a fatal error.
  '.pfb', '.tfm', '.vf', '.afm', '.enc', '.map', '.ttc', '.bmp', '.tif', '.tiff', '.mps',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.latex-preview', '.vscode', '__pycache__']);

// The subset of TEXT_EXT that TeX resolves *by name* rather than by path:
// `\documentclass{myvenue}`, `\usepackage{mypkg}`, `\bibliography{refs}`,
// `\input{body}`. A directory holding one of these has to be on the search path
// or the file is invisible to a local TeX no matter where it sits. Data files
// (.csv/.dat) are excluded deliberately — pgfplots reads those through a path
// the author wrote out, so they never need a lookup and would only lengthen the
// environment.
const SEARCHED_EXT = new Set([
  '.tex', '.ltx', '.inc', '.cls', '.sty', '.bst', '.bib', '.clo', '.def', '.ldf',
  '.fd', '.bbx', '.cbx', '.lbx', '.bbl', '.ist', '.gst', '.pgf', '.tikz',
]);
// A ceiling on the search path itself. Every entry is a directory kpathsea
// stats on each lookup, and Windows caps a single environment variable at 32 KB;
// a generated project with a directory per figure would blow through both.
const MAX_SEARCH_DIRS = 128;

const MAX_TOTAL_BYTES = 60 * 1024 * 1024; // 60 MB
const MAX_FILES = 800;
// A ceiling on the scan itself, not on what we send. The caps below need the
// whole candidate list before they can choose, so the walk can no longer stop
// the moment a budget runs out; this keeps a project root pointed at a home
// directory from turning into an unbounded traversal.
const MAX_SCANNED = 20_000;

export interface CollectOptions {
  /** The project-relative main file, when the caller knows it. It is collected
   *  first, and its own build outputs are skipped. */
  mainFile?: string;
  /** Read only the text sources. The stats still describe the whole project, so
   *  `count`/`totalBytes`/`truncated` mean the same thing either way. */
  textOnly?: boolean;
}

export interface CollectResult {
  files: EngineFile[];
  truncated: boolean;
  totalBytes: number;
  /** How many files the caps admitted — including binaries that `textOnly` did
   *  not read, so this always describes the project rather than the request. */
  count: number;
  /** What the caps left out, for a caller that has to explain a missing figure. */
  skippedFiles: number;
  skippedBytes: number;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

const toPosix = (p: string) => p.split(sep).join('/');

export function collectProjectFiles(projectRoot: string, opts: CollectOptions = {}): Promise<CollectResult> {
  return walkProject(projectRoot, true, opts);
}

/**
 * How big the project is, without reading any of it.
 *
 * The same tree and the same caps as `collectProjectFiles`, so the number it
 * reports means the same thing — but it only stats. The system backend hands
 * latexmk a directory and lets it read from disk, so collecting the contents
 * there was 32.4 MB read and discarded on every save of a real IEEE paper (the
 * cap is 60 MB), purely to be able to say "49 files" at the end.
 */
export async function countProjectFiles(
  projectRoot: string,
  opts: CollectOptions = {},
): Promise<{ count: number; truncated: boolean; totalBytes: number; skippedFiles: number; skippedBytes: number }> {
  const { count, truncated, totalBytes, skippedFiles, skippedBytes } = await walkProject(projectRoot, false, opts);
  return { count, truncated, totalBytes, skippedFiles, skippedBytes };
}

/**
 * The project directories a locally installed TeX has to be told about.
 *
 * kpathsea searches its own trees and the current directory, never a project's
 * subdirectories. So a paper shipping `styles/myvenue.cls` and saying
 * `\documentclass{myvenue}` — or `bib/refs.bib` and `\bibliography{refs}` —
 * fails on the system backend with "file not found" while the file is
 * demonstrably right there, and the bibliography one fails *silently*: bibtex
 * writes an empty .bbl and every citation renders as `[?]`. The bundled engine
 * works around this by aliasing those files to the root
 * (`flattenedClassAliases`); a real TeX wants TEXINPUTS/BIBINPUTS instead.
 *
 * Derived from paths `collectProjectFiles` has already returned rather than from
 * a second traversal, so it is the same walk under the same skip rules
 * (SKIP_DIRS, dotdirs, `.latex-preview`) and costs nothing extra.
 *
 * The result is relative and posix-separated; the caller joins it onto the root.
 */
export function searchPathDirs(relativePaths: string[], mainFile?: string): string[] {
  const mainDir = mainFile ? dirname(toPosix(mainFile).replace(/^\.\//, '')) : '.';
  // Order is fixed rather than incidental: the main file's own directory first
  // (with `-cd` that is also the compile's working directory, so it is where a
  // document's private class most often lives), then the project root, then the
  // rest shallowest-first. A stable order means the same project produces the
  // same environment on every compile — latexmk records the environment it ran
  // under, and a list that reshuffled would force needless rebuilds.
  const seen = new Set<string>(['.', mainDir]);
  const rest: string[] = [];
  for (const rel of relativePaths) {
    if (!SEARCHED_EXT.has(extOf(rel))) continue;
    const dir = dirname(toPosix(rel));
    if (seen.has(dir)) continue;
    seen.add(dir);
    rest.push(dir);
  }
  rest.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return [mainDir, ...(mainDir === '.' ? [] : ['.']), ...rest].slice(0, MAX_SEARCH_DIRS);
}

interface Candidate {
  full: string;
  rel: string;
  size: number;
  isText: boolean;
}

async function walkProject(projectRoot: string, readContents: boolean, opts: CollectOptions): Promise<CollectResult> {
  const mainRel = opts.mainFile ? toPosix(opts.mainFile).replace(/^\.\//, '') : undefined;
  // A project's own build outputs are not inputs. A 20 MB `main.pdf` left by a
  // previous latexmk run ate a third of the whole budget on the way to evicting
  // the sources that produced it.
  const buildOutputs = new Set(
    mainRel
      ? [`${stripExt(mainRel)}.pdf`, `${stripExt(mainRel)}.synctex.gz`]
      : [],
  );

  const candidates: Candidate[] = [];
  let scanned = 0;
  let overflowed = false;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extOf(e.name);
      const isText = TEXT_EXT.has(ext);
      const isBin = BINARY_EXT.has(ext);
      if (!isText && !isBin) continue;
      const rel = toPosix(relative(projectRoot, full));
      if (buildOutputs.has(rel)) continue;
      if (scanned++ >= MAX_SCANNED) { overflowed = true; return; }

      const s = await stat(full).catch(() => null);
      if (!s) continue;
      candidates.push({ full, rel, size: s.size, isText });
    }
  }

  await walk(projectRoot);

  // The order the caps see, and the whole point of this rewrite. It used to be
  // directory order, which is alphabetical — so `figures/` came before
  // `main.tex`, and a thesis with 70 MB of plots had its own source evicted by
  // its own illustrations. The engine then compiled an empty string and reported
  // an emergency stop, with nothing anywhere saying the paper had been dropped.
  //
  // Main file first (it is the one file without which nothing else means
  // anything), then every text source, then the binaries with whatever budget
  // is left. Losing a figure degrades a preview; losing a chapter destroys it.
  //
  // Shallowest first within each tier, because callers that do not know the main
  // file still need the document root to survive: 900 generated fragments under
  // `aaa/` are all text too, and in directory order they filled the file cap
  // before `main.tex` was ever reached.
  const rank = (c: Candidate) => (c.rel === mainRel ? 0 : c.isText ? 1 : 2);
  const depth = (c: Candidate) => c.rel.split('/').length;
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || depth(a.c) - depth(b.c) || a.i - b.i)
    .map(({ c }) => c);

  const picked: Candidate[] = [];
  let totalBytes = 0;
  let truncated = overflowed;
  let skippedFiles = overflowed ? 1 : 0; // at least the one that tripped the scan cap
  let skippedBytes = 0;
  for (const c of ordered) {
    // The main file is never subject to the caps: a budget that can drop the
    // document root is not a budget, it is a bug with a number attached.
    const exempt = c.rel === mainRel;
    if (!exempt && (picked.length >= MAX_FILES || totalBytes + c.size > MAX_TOTAL_BYTES)) {
      truncated = true;
      skippedFiles++;
      skippedBytes += c.size;
      continue;
    }
    picked.push(c);
    totalBytes += c.size;
  }

  const files: EngineFile[] = [];
  if (readContents) {
    for (const c of picked) {
      if (!c.isText) {
        if (opts.textOnly) continue;
        files.push({ path: c.rel, content: (await readFile(c.full)).toString('base64'), encoding: 'base64' });
        continue;
      }
      files.push(await readTextFile(c));
    }
  }

  return { files, truncated, totalBytes, count: picked.length, skippedFiles, skippedBytes };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Text, but only if it really is UTF-8.
 *
 * `readFile(…, 'utf8')` never fails: it replaces every byte it cannot decode
 * with U+FFFD. A Latin-1 paper — `\usepackage[latin1]{inputenc}`, still common
 * in older European theses — therefore reached the engine with every accented
 * character replaced by a replacement character, and compiled into a PDF full of
 * question marks with no error anywhere. Sending the original bytes as base64
 * instead costs nothing and preserves the file exactly; the engine writes both
 * encodings to its filesystem the same way.
 */
async function readTextFile(c: Candidate): Promise<EngineFile> {
  const buf = await readFile(c.full);
  try {
    return { path: c.rel, content: UTF8.decode(buf), encoding: 'utf8' };
  } catch {
    return { path: c.rel, content: buf.toString('base64'), encoding: 'base64' };
  }
}

function stripExt(rel: string): string {
  const dir = dirname(rel);
  const name = basename(rel).replace(/\.[^.]*$/, '');
  return dir === '.' ? name : `${toPosix(dir)}/${name}`;
}
