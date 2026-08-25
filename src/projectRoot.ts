// Which folder is "the project"? Every MCP tool answers that with one
// directory, and that directory used to be process.cwd() with no way to say
// otherwise. Claude Code and Codex spawn the server inside the paper, so cwd was
// right and nobody noticed; other clients start their servers from the user's
// home directory or from `/`. There cwd is not a paper at all, and the server
// would still start a recursive file watcher on it and let the coordinator
// create `.latex-preview/history.git` inside it before anything complained that
// there were no .tex files.
//
// So: an explicit override first, cwd only as the default, and a guard the tools
// run before they touch the directory.
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { MainFileError } from './project/resolveMainFile.js';

const TOOL_DIR = '.latex-preview';

/** `--project <dir>` on the server's own argv, else `$TEXCHRONICLE_PROJECT`,
 *  else the current working directory. Always absolute. */
export function initialProjectRoot(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromArgv = projectArgument(argv);
  const fromEnv = env.TEXCHRONICLE_PROJECT?.trim();
  return resolve(fromArgv || fromEnv || process.cwd());
}

/** Read `--project <dir>` / `--project=<dir>` out of an argv without pulling in
 *  a parser: this runs before anything else and must not reject the argv shapes
 *  the standalone CLI accepts. */
function projectArgument(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--project' || argument === '-p') {
      const value = argv[i + 1];
      if (value && !value.startsWith('-')) return value;
    }
    if (argument.startsWith('--project=')) {
      const value = argument.slice('--project='.length);
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Refuse to treat `root` as the paper when it plainly is not one.
 *
 * Deliberately cheap and permissive: an explicit main file that exists, or any
 * .tex at the top level, is enough. This is not a validity check — resolveMainFile
 * still does that — it only separates "a folder holding a paper" from "somebody's
 * home directory", because the difference decides whether we may write there.
 */
export async function assertLooksLikeProject(root: string, mainFile?: string): Promise<void> {
  if (await holdsMainFile(root, mainFile)) return;
  if (await hasTopLevelTex(root)) return;
  throw new MainFileError(wrongRootHelp(root, mainFile));
}

/**
 * The looser check for tools that only READ the project's store. A directory
 * TeXChronicle has previewed before already has a `.latex-preview`, so reading
 * it creates nothing new — and that covers the legitimate project whose sources
 * all live in a subdirectory, which the strict check above would reject.
 */
export async function assertKnownProject(root: string): Promise<void> {
  const store = await stat(join(root, TOOL_DIR)).catch(() => null);
  if (store?.isDirectory()) return;
  await assertLooksLikeProject(root);
}

async function holdsMainFile(root: string, mainFile?: string): Promise<boolean> {
  if (!mainFile) return false;
  // Mirror resolveMainFile's `paper` → `paper.tex` shorthand, or a main file
  // that compiles today would fail this guard on the way in.
  const normalized = mainFile.replace(/\\/g, '/');
  const candidates = /\.tex$/i.test(normalized) ? [normalized] : [normalized, `${normalized}.tex`];
  for (const candidate of candidates) {
    const paths = isAbsolute(candidate) ? [candidate] : [join(root, candidate)];
    for (const path of paths) {
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) return true;
    }
  }
  return false;
}

async function hasTopLevelTex(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return false;
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tex'));
}

/** Name the directory, then the three ways to point at the paper. The reader is
 *  usually looking at a client that started the server somewhere they never
 *  chose, so "no .tex files found" on its own tells them nothing they can act on. */
function wrongRootHelp(root: string, mainFile?: string): string {
  const missing = mainFile ? `, and no ${mainFile} inside it` : '';
  return `${root} does not look like a LaTeX project — there is no .tex file at its top level${missing}.

TeXChronicle previews the folder its server was started in, and some MCP clients (Claude Desktop among them) start servers from your home directory rather than from the paper. Point it at the paper in one of these ways:

  • add an env block to this server's entry in your MCP config: "env": { "TEXCHRONICLE_PROJECT": "/abs/path" }
  • pass the folder as a server argument: --project /abs/path
  • start the server from the paper's own folder

If the paper IS this folder but its sources live in a subdirectory, pass "mainFile" instead — for example "src/main.tex".`;
}
