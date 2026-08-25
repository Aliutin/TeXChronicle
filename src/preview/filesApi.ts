// Source-panel file API: list/read/write the project's editable text files.
// Writes go straight to disk — the file watcher then recompiles and the WS
// reload refreshes the PDF, so "save in the browser editor" reuses the exact
// same live loop as any other edit (Claude's or an external editor's).
import { readdir, readFile, writeFile, mkdir, rename, rm, stat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, normalize, posix, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gitOrNull } from '../git/exec.js';

const TEXT_EXT = /\.(tex|bib|cls|sty|bst|cfg|clo|def|ldf|fd|bbx|cbx|lbx|txt|md)$/i;
// Figures/assets: shown in the tree (not editable) and allowed for upload.
const FIGURE_EXT = /\.(png|jpe?g|gif|pdf|eps|svg)$/i;
const isListable = (name: string) => TEXT_EXT.test(name) || FIGURE_EXT.test(name);
const isWritable = (name: string) => TEXT_EXT.test(name) || FIGURE_EXT.test(name);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.latex-preview', '.vscode', '__pycache__']);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;  // 4 MB per LaTeX source
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB per uploaded figure
const ASSET_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.eps'];
const assetBoundaryCache = new Map<string, Promise<string>>();

const toPosix = (p: string) => p.split(sep).join('/');

/** Containment test for two already-resolved absolute paths. Case-folded on
 *  Windows, where the same directory can differ only by case. */
const samePathOrInside = (parent: string, child: string): boolean => {
  const a = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const b = process.platform === 'win32' ? child.toLowerCase() : child;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
};

export async function listTextFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && TEXT_EXT.test(e.name)) {
        out.push(toPosix(relative(root, full)));
      }
    }
  }
  await walk(root);
  // main.tex first, then alphabetical — matches how people think about a project.
  return out.sort((a, b) => {
    const am = /(^|\/)main\.tex$/i.test(a) ? 0 : 1;
    const bm = /(^|\/)main\.tex$/i.test(b) ? 0 : 1;
    return am - bm || a.localeCompare(b);
  });
}

export interface TreeNode { name: string; path: string; type: 'file' | 'dir'; editable?: boolean; children?: TreeNode[] }

/** Nested tree of folders + editable text files and figure assets. */
export async function listTree(root: string): Promise<TreeNode[]> {
  async function walk(dir: string): Promise<TreeNode[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = toPosix(relative(root, full));
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        nodes.push({ name: e.name, path: rel, type: 'dir', children: await walk(full) });
      } else if (e.isFile() && isListable(e.name)) {
        nodes.push({ name: e.name, path: rel, type: 'file', editable: TEXT_EXT.test(e.name) });
      }
    }
    // folders first, then main.tex, then alphabetical.
    return nodes.sort((a, b) =>
      (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) ||
      (/^main\.tex$/i.test(a.name) ? -1 : /^main\.tex$/i.test(b.name) ? 1 : 0) ||
      a.name.localeCompare(b.name));
  }
  return walk(root);
}

/**
 * Resolve a client path safely inside the root. `requireText` for edit ops.
 *
 * Two checks, and the second is the one that was missing.
 *
 * The lexical check confines the *string*: `..`, absolute paths and encoded
 * traversal are all rejected, and the root comparison includes the separator so
 * a sibling named `project-evil` cannot pass as inside `project`.
 *
 * But a string is not an inode. Without resolving symlinks, a link INSIDE the
 * project points anywhere: git stores symlinks, so a cloned LaTeX template or an
 * Overleaf import can ship `notes.tex -> ../../../.ssh/id_rsa`. Every lexical
 * check passes and `readFile` follows the link straight out of the project —
 * and `writeFile` follows it the other way, which is write-anywhere. The tree
 * listing uses `isFile()`, so such a link is never even displayed; it only has
 * to be named in a request.
 */
async function guardPath(root: string, rel: string, requireText = false): Promise<string> {
  const clean = String(rel).replace(/^[/\\]+/, '');
  if (!clean || clean.split(/[/\\]/).some((s) => s === '..' || s === '.')) throw new Error('invalid path');
  if (requireText && !TEXT_EXT.test(clean)) throw new Error('unsupported file type');
  const full = normalize(resolve(root, clean));
  const rootAbs = normalize(resolve(root)) + sep;
  if (!full.startsWith(rootAbs)) throw new Error('path outside project');
  if (SKIP_DIRS.has(clean.split(/[/\\]/)[0])) throw new Error('protected directory');

  // Now the same question about the real path. The target may not exist yet
  // (create, first write), so walk up to the deepest ancestor that does and
  // resolve that — a symlinked parent directory is the same escape.
  const realRoot = normalize(await realpath(root));
  let probe = full;
  for (;;) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(probe);
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
      continue;
    }
    const resolved = normalize(real + full.slice(probe.length));
    if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
      throw new Error('path leaves the project through a symlink');
    }
    return full;
  }
  return full;
}

const guard = (root: string, rel: string) => guardPath(root, rel, true);

export async function createTextFile(root: string, rel: string): Promise<void> {
  const full = await guard(root, rel);
  if (await stat(full).then(() => true, () => false)) throw new Error('file already exists');
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, '', 'utf8');
}

export async function createDir(root: string, rel: string): Promise<void> {
  await mkdir(await guardPath(root, rel), { recursive: true });
}

export async function renameEntry(root: string, from: string, to: string): Promise<void> {
  await mkdir(dirname(await guardPath(root, to)), { recursive: true });
  await rename(await guardPath(root, from), await guardPath(root, to));
}

export async function deleteEntry(root: string, rel: string): Promise<void> {
  await rm(await guardPath(root, rel), { recursive: true, force: true });
}

/** Identifies the exact bytes a reader saw, so a later write can prove nothing
 *  else changed them in between. */
const etagOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface TextFileContent {
  content: string;
  /** sha256 of the bytes on disk. Sent as the ETag; echoed back as If-Match. */
  etag: string;
}

/**
 * Read a source file for the editor — or refuse, rather than corrupt it.
 *
 * `readFile(p,'utf8')` decodes leniently: every byte it cannot make sense of
 * becomes U+FFFD. That is silent and it is one-way. A Latin-1 `.tex` (still
 * ordinary in older papers — `\usepackage[latin1]{inputenc}`) opened fine, and
 * the very next save, even one that changed nothing, wrote every é back as a
 * replacement character. Measured: `e9` in, `ef bf bd` out. A UTF-16 file from
 * Notepad lost its whole text the same way.
 *
 * A fatal decoder makes that impossible: a file we cannot round-trip is one we
 * decline to open, with a message that says how to convert it and what still
 * works meanwhile. `ignoreBOM` keeps a UTF-8 BOM in the string — dropping it
 * here is what would make an untouched save rewrite the file's first bytes.
 */
export async function readTextFileWithEtag(root: string, rel: string): Promise<TextFileContent> {
  const bytes = await readFile(await guard(root, rel));
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(
      `${rel} is not UTF-8 (probably Latin-1 or UTF-16). TeXChronicle will not open it in the editor, ` +
      "because saving would replace every non-UTF-8 character with '?'. " +
      'Convert it first (e.g. iconv -f latin1 -t utf8), or keep editing it in your own editor — ' +
      'compiling and history still work.',
    );
  }
  return { content, etag: etagOf(bytes) };
}

export async function readTextFile(root: string, rel: string): Promise<string> {
  return (await readTextFileWithEtag(root, rel)).content;
}

export interface ResolvedAssetFile { fullPath: string; relativePath: string }
export interface ResolvedIncludeFile { fullPath: string; relativePath: string; editable: boolean }

/** Remove TeX comments without treating an escaped \% as a comment marker. */
function withoutTexComments(source: string): string {
  return source.split(/\r?\n/).map((line) => {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== '%') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) slashes += 1;
      if (slashes % 2 === 0) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

interface GraphicsSourcePaths { directories: string[]; references: Set<string> }

const texPathKey = (value: string): string => {
  const normalized = posix.normalize(value.trim().replace(/\\/g, '/')).replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/** Read the literal paths that graphicx itself uses. Macro-generated paths are
 * intentionally left to TeX; resolving those correctly requires expansion, not
 * a misleading approximation. */
function graphicsPathsFromSource(source: string): GraphicsSourcePaths {
  const active = withoutTexComments(source);
  const directories: string[] = [];
  const references = new Set<string>();

  for (const match of active.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)) {
    const value = match[1].trim();
    if (value && !value.includes('\\')) references.add(texPathKey(value));
  }

  // A graphicspath body is a list of individually braced directories:
  // \graphicspath{{./Figures/}{../shared/figures/}}
  for (const command of active.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
    for (const entry of command[1].matchAll(/\{([^{}]*)\}/g)) {
      const value = entry[1].trim();
      if (value && !value.includes('\\') && !directories.includes(value)) directories.push(value);
    }
  }
  return { directories, references };
}

/** A paper is often launched from `repo/paper/draft`, while its TeX source uses
 * `../figures/map.pdf`. Editing and history must remain scoped to `draft`, but a
 * read-only artwork route needs the enclosing repository as its natural safety
 * boundary. Plain folders have no such wider boundary and stay project-local. */
async function assetBoundary(root: string): Promise<string> {
  const rootAbs = normalize(resolve(root));
  let pending = assetBoundaryCache.get(rootAbs);
  if (!pending) {
    pending = (async () => {
      const repository = (await gitOrNull(rootAbs, ['rev-parse', '--show-toplevel']))?.trim();
      if (!repository) return rootAbs;
      const repositoryAbs = normalize(resolve(repository));
      return rootAbs === repositoryAbs || rootAbs.startsWith(repositoryAbs + sep)
        ? repositoryAbs
        : rootAbs;
    })();
    assetBoundaryCache.set(rootAbs, pending);
  }
  return pending;
}

/** Resolve a read-only TeX include used to build the Live document model. The
 * editor's ordinary /api/file route intentionally remains project-local; this
 * wider route exists only so a nested draft can display generated tables kept
 * elsewhere in the same Git work tree. */
export async function resolveIncludeFile(root: string, rel: string): Promise<ResolvedIncludeFile> {
  let requested = String(rel).trim().replace(/\\/g, '/');
  if (!requested || posix.isAbsolute(requested) || /^[a-z]:\//i.test(requested)) {
    throw new Error('path outside project');
  }
  if (!posix.extname(requested)) requested += '.tex';
  if (!/\.tex$/i.test(requested)) throw new Error('unsupported include type');

  const rootAbs = normalize(resolve(root));
  const boundary = normalize(resolve(await assetBoundary(rootAbs)));
  const absolute = normalize(resolve(rootAbs, requested));
  if (absolute !== boundary && !absolute.startsWith(boundary + sep)) {
    throw new Error('path outside project');
  }

  const guarded = await guardPath(boundary, toPosix(relative(boundary, absolute)), true);
  const info = await stat(guarded).catch(() => null);
  if (!info?.isFile()) throw new Error('include not found');
  const projectRelative = toPosix(relative(rootAbs, guarded));
  const [realProject, realInclude] = await Promise.all([realpath(rootAbs), realpath(guarded)]);
  const editable = realInclude.startsWith(normalize(realProject) + sep);
  return { fullPath: guarded, relativePath: projectRelative, editable };
}

/**
 * How far outside the boundary a TeX reference may reach: one directory, and
 * nothing at a filesystem root.
 *
 * The escape exists for one real shape — `paper/draft` including
 * `../figures/map.pdf`, artwork the author keeps beside the draft — and the
 * "the source names it, so it is allowed" rule was written for that. But
 * "names it" is not a boundary: `\graphicspath{{../../}}` in a downloaded
 * template, or an absolute path left in a .tex by a collaborator, made
 * /api/asset serve any .png/.pdf/.svg anywhere on the disk, and any .tex in the
 * project can name one. A cap turns the rule back into what it was meant to be.
 *
 * At `C:\` or `/` there is no "one directory up" worth having — the parent is
 * the whole volume — so those projects simply do not get the escape.
 */
function assetEscapeLimit(boundaryAbs: string): string | null {
  const parent = normalize(resolve(boundaryAbs, '..'));
  return parent === boundaryAbs || dirname(parent) === parent ? null : parent;
}

/** Resolve an image/PDF for browser display using the same ordinary search
 * locations as graphicx: the compiler directory, the including source's
 * directory, and every literal directory declared by \graphicspath. A literal
 * includegraphics reference may point one directory beyond the normal
 * project/Git boundary; that exact read-only asset is allowed because the
 * selected TeX source already names it. Unreferenced browser paths retain the
 * strict boundary, and an absolute reference never earns the escape at all. */
export async function resolveAssetFile(root: string, rel: string, from?: string): Promise<ResolvedAssetFile> {
  const raw = String(rel).trim().replace(/\\/g, '/');
  if (!raw) throw new Error('invalid path');
  const rawIsAbsolute = posix.isAbsolute(raw) || /^[a-z]:\//i.test(raw);

  const boundary = await assetBoundary(root);
  const boundaryAbs = normalize(resolve(boundary));
  const rootAbs = normalize(resolve(root));
  const escapeLimit = assetEscapeLimit(boundaryAbs);
  const withinEscapeLimit = (absolute: string): boolean =>
    escapeLimit !== null && samePathOrInside(escapeLimit, absolute);
  const bases: Array<{ absolute: string; outsideAllowed: boolean }> = [];
  const addAbsolute = (absolutePath: string, outsideAllowed = false): void => {
    const absolute = normalize(resolve(absolutePath));
    const insideBoundary = absolute === boundaryAbs || absolute.startsWith(boundaryAbs + sep);
    if (!insideBoundary && !(outsideAllowed && withinEscapeLimit(absolute))) return;
    const existing = bases.find((base) => base.absolute === absolute);
    if (existing) {
      existing.outsideAllowed ||= outsideAllowed;
      return;
    }
    bases.push({ absolute, outsideAllowed });
  };

  // Graphics paths are normally relative to the compiler's working directory,
  // which is the selected project root.
  if (!rawIsAbsolute) addAbsolute(resolve(rootAbs, raw));

  // Packages such as import/subfiles make a path relative to an included TeX
  // file. Preserve that useful fallback, but first prove `from` itself is a
  // regular source path inside the selected project. Reading the source also
  // lets us honor graphicx's declared search directories.
  if (from) {
    const source = String(from).trim().replace(/\\/g, '/');
    const normalizedSource = posix.normalize(source).replace(/^\.\//, '');
    if (normalizedSource && normalizedSource !== '.' && normalizedSource !== '..' &&
        !normalizedSource.startsWith('../') && !posix.isAbsolute(normalizedSource) &&
        !/^[a-z]:\//i.test(normalizedSource)) {
      const sourceFull = await guardPath(root, normalizedSource, true);
      // The Live model can briefly refer to an include before the editor has
      // written that file. Keep the historical source-directory fallback in
      // that case; only declared graphicspath entries require readable source.
      const sourceText = await readFile(sourceFull, 'utf8').catch(() => '');
      const declared = graphicsPathsFromSource(sourceText);
      const explicitlyReferenced = declared.references.has(texPathKey(raw));

      if (rawIsAbsolute) {
        // An absolute path in a .tex is served only when it lands inside the
        // boundary anyway — being named by the source buys it nothing. There is
        // no legitimate reading of "C:/Users/someone/private.png" that the
        // browser needs from us, and treating it as authorised is how a single
        // line in a shared template became read-anything.
        addAbsolute(raw, false);
      } else {
        addAbsolute(resolve(dirname(sourceFull), raw), explicitlyReferenced);
        for (const graphicsDir of declared.directories) {
          const directoryIsAbsolute = posix.isAbsolute(graphicsDir) || /^[a-z]:\//i.test(graphicsDir);
          const compilerBase = directoryIsAbsolute ? graphicsDir : resolve(rootAbs, graphicsDir);
          addAbsolute(resolve(compilerBase, raw), explicitlyReferenced);

          // import/subfiles users sometimes declare graphicspath relative to the
          // included file. Trying both mirrors the existing source-dir fallback
          // while preserving TeX's compiler-directory choice first.
          if (!directoryIsAbsolute) {
            addAbsolute(resolve(dirname(sourceFull), graphicsDir, raw), explicitlyReferenced);
          }
        }
      }
    }
  }
  if (!bases.length) throw new Error('path outside project');

  const candidates: Array<{ absolute: string; outsideAllowed: boolean }> = [];
  for (const base of bases) {
    const extension = posix.extname(base.absolute.replace(/\\/g, '/'));
    if (extension) {
      if (!FIGURE_EXT.test(base.absolute)) throw new Error('unsupported asset type');
      candidates.push(base);
    } else {
      for (const ext of ASSET_EXTENSIONS) {
        candidates.push({ absolute: base.absolute + ext, outsideAllowed: base.outsideAllowed });
      }
    }
  }

  // Resolved lazily and once: the limit is only needed when something actually
  // reaches outside, and realpath costs a syscall.
  let realEscapeLimit: string | undefined;
  const escapesThroughSymlink = async (fullPath: string): Promise<boolean> => {
    if (escapeLimit === null) return true;
    if (realEscapeLimit === undefined) {
      realEscapeLimit = normalize(await realpath(escapeLimit).catch(() => escapeLimit));
    }
    return !samePathOrInside(realEscapeLimit, fullPath);
  };

  for (const candidate of candidates) {
    const insideBoundary = candidate.absolute !== boundaryAbs && candidate.absolute.startsWith(boundaryAbs + sep);
    try {
      let fullPath: string | null = null;
      if (insideBoundary) {
        fullPath = await guardPath(boundaryAbs, toPosix(relative(boundaryAbs, candidate.absolute)));
      } else if (candidate.outsideAllowed) {
        // The lexical cap above confined the string; a symlink is the same
        // escape by another route, so the resolved path has to answer too.
        const real = normalize(await realpath(candidate.absolute));
        fullPath = await escapesThroughSymlink(real) ? null : real;
      }
      if (!fullPath) continue;
      const info = await stat(fullPath);
      if (info.isFile()) return { fullPath, relativePath: toPosix(relative(rootAbs, fullPath)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('asset not found');
}

/** The write was refused because the file is no longer what the editor loaded.
 *  Its message is the HTTP body verbatim; the route maps it to 409. */
export class FileChangedOnDiskError extends Error {
  constructor() {
    super('file changed on disk');
    this.name = 'FileChangedOnDiskError';
  }
}

export interface WriteTextOptions {
  /** An ETag the caller believes is still current. When given, the write
   *  happens only if the bytes on disk still hash to it. */
  ifMatch?: string;
  /** Run once the write is certain to go ahead and before it starts — the file
   *  watcher's own-write suppression belongs here, so a refused write never
   *  leaves the watcher primed to swallow somebody else's change. */
  beforeWrite?: () => void | Promise<void>;
}

/** Accepts `"abc"`, `abc` and `W/"abc"`; `*` means "whatever is there now". */
const parseEtag = (value: string): string => value.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');

/**
 * Save a source file.
 *
 * Two failures this guards against, both of which cost text that was never
 * anywhere else:
 *
 * **A half-written paper.** `writeFile` truncates first and fills after, so a
 * crash, a full disk or a killed process in between leaves the .tex empty or
 * cut in half — and the file watcher, polling every 500 ms, can read that state
 * and compile it. Writing a sibling temp file and renaming makes the swap
 * atomic: a reader sees the whole old file or the whole new one.
 *
 * **A silent overwrite.** Two browser tabs, or a tab and Claude's own Edit, and
 * the last save wins with no sign that anything was lost. `ifMatch` gives the
 * caller a way to say which version it edited; a mismatch refuses instead of
 * flattening the other change.
 */
export async function writeTextFile(
  root: string,
  rel: string,
  content: string,
  options: WriteTextOptions = {},
): Promise<{ etag: string }> {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('file too large');
  const full = await guard(root, rel);

  if (options.ifMatch !== undefined) {
    const expected = parseEtag(options.ifMatch);
    const current = await readFile(full).then(etagOf, () => undefined);
    // A file that has since been deleted is "changed" too — the version the
    // editor is holding cannot be written back over something that is gone
    // without deciding, on the user's behalf, that it should come back.
    const matches = expected === '*' ? current !== undefined : current === expected.toLowerCase();
    if (!matches) throw new FileChangedOnDiskError();
  }

  await options.beforeWrite?.();

  const bytes = Buffer.from(content, 'utf8');
  // Same directory, so the rename is a rename and not a cross-volume copy.
  // Leading dot and a non-source suffix keep it out of the file tree, the
  // watcher and the checkpoint walk for the moment it exists.
  const temporary = join(dirname(full), `.${basename(full)}.tc-save-${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, full);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    // Windows can refuse the rename while another process holds the target open
    // — Dropbox and antivirus scanners both do, briefly. A direct write is the
    // weaker guarantee, but "your save did not happen" is the worse answer.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
    await writeFile(full, bytes);
  }
  return { etag: etagOf(bytes) };
}

/** Write an uploaded figure/asset (or text file) as raw bytes, guarded. */
export async function writeUpload(root: string, rel: string, data: Buffer): Promise<void> {
  const clean = String(rel).replace(/^[/\\]+/, '');
  if (!isWritable(clean)) throw new Error('unsupported file type');
  if (data.length > MAX_UPLOAD_BYTES) throw new Error('file too large (max 25 MB)');
  const full = await guardPath(root, clean); // path safety (traversal / protected dirs)
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
}
