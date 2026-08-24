// Source-panel file API: list/read/write the project's editable text files.
// Writes go straight to disk — the file watcher then recompiles and the WS
// reload refreshes the PDF, so "save in the browser editor" reuses the exact
// same live loop as any other edit (Claude's or an external editor's).
import { readdir, readFile, writeFile, mkdir, rename, rm, stat, realpath } from 'node:fs/promises';
import { dirname, join, normalize, posix, relative, resolve, sep } from 'node:path';
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

export async function readTextFile(root: string, rel: string): Promise<string> {
  return readFile(await guard(root, rel), 'utf8');
}

export interface ResolvedAssetFile { fullPath: string; relativePath: string }
export interface ResolvedIncludeFile { fullPath: string; relativePath: string; editable: boolean }

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

/** Resolve an image/PDF for browser display. TeX accepts an omitted graphics
 * extension and papers commonly keep figures beside the selected draft folder.
 * Such sibling assets are allowed only inside the enclosing Git work tree; the
 * existing realpath guard still prevents symlinks from escaping that boundary. */
export async function resolveAssetFile(root: string, rel: string, from?: string): Promise<ResolvedAssetFile> {
  const raw = String(rel).trim().replace(/\\/g, '/');
  if (!raw) throw new Error('invalid path');
  if (posix.isAbsolute(raw) || /^[a-z]:\//i.test(raw)) throw new Error('path outside project');

  const boundary = await assetBoundary(root);
  const boundaryAbs = normalize(resolve(boundary));
  const bases: string[] = [];
  const addBase = (baseDir: string): void => {
    const absolute = normalize(resolve(baseDir, raw));
    if (absolute !== boundaryAbs && !absolute.startsWith(boundaryAbs + sep)) return;
    const candidate = toPosix(relative(boundaryAbs, absolute));
    if (candidate && !bases.includes(candidate)) bases.push(candidate);
  };

  // Graphics paths are normally relative to the compiler's working directory,
  // which is the selected project root.
  addBase(root);

  // Packages such as import/subfiles make a path relative to an included TeX
  // file. Preserve that useful fallback, but first prove `from` itself is a
  // regular source path inside the selected project.
  if (from) {
    const source = String(from).trim().replace(/\\/g, '/');
    const normalizedSource = posix.normalize(source).replace(/^\.\//, '');
    if (normalizedSource && normalizedSource !== '.' && normalizedSource !== '..' &&
        !normalizedSource.startsWith('../') && !posix.isAbsolute(normalizedSource) &&
        !/^[a-z]:\//i.test(normalizedSource)) {
      const sourceFull = await guardPath(root, normalizedSource, true);
      addBase(dirname(sourceFull));
    }
  }
  if (!bases.length) throw new Error('path outside project');

  const candidates: string[] = [];
  for (const base of bases) {
    const extension = posix.extname(base);
    if (extension) {
      if (!FIGURE_EXT.test(base)) throw new Error('unsupported asset type');
      candidates.push(base);
    } else {
      for (const ext of ASSET_EXTENSIONS) candidates.push(base + ext);
    }
  }

  for (const candidate of candidates) {
    const fullPath = await guardPath(boundaryAbs, candidate);
    try {
      const info = await stat(fullPath);
      if (info.isFile()) return { fullPath, relativePath: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('asset not found');
}

export async function writeTextFile(root: string, rel: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('file too large');
  await writeFile(await guard(root, rel), content, 'utf8');
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
