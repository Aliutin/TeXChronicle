// The one shared compile path: resolve main file -> gather project -> compile.
// Both the render_preview MCP tool and (later) the file watcher call this.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MainFileError, resolveMainFile } from './resolveMainFile.js';
import { collectProjectFiles, searchPathDirs } from './collectProjectFiles.js';
import { getFallbackStyles } from '../engine/fallbackStyles.js';
import { compile, type CompileOutput, type EngineFile } from '../engine/browserHost.js';
import { probeSystemTex, compileWithSystemTex, systemTexUnavailableMessage, MIKTEX_ASK_NOTE, type SystemTexProbe, type SystemFallback } from '../engine/systemTex.js';
import { classifyCompile, stubPackage, usesPackage, type CompileVerdict } from '../engine/compileLog.js';

export type Engine = 'xelatex' | 'pdflatex' | 'lualatex';
// Which compiler runs: 'wasm' (bundled busytex, zero-install; default),
// 'system' (local latexmk, full fidelity), or 'auto' (system if present else wasm).
export type Backend = 'wasm' | 'system' | 'auto';

export interface CompileProjectResult extends CompileOutput {
  mainFile: string;
  engine: Engine;
  backend: 'wasm' | 'system';
  fileCount: number;
  truncated: boolean;
  /** What the TeX log says actually happened (wasm backend). */
  verdict?: CompileVerdict;
  /** Missing packages stubbed out to get past a stale \usepackage. */
  stubbedPackages?: string[];
  /** Advisory notes about this compile that the caller should surface verbatim
   *  (e.g. "biblatex needs biber, which the bundled engine lacks"). Never an
   *  error by themselves; they explain a PDF that may not look as expected. */
  notes?: string[];
  /** Set when 'auto' tried the local TeX first and it produced nothing usable,
   *  so this result came from the bundled engine instead. Carried so the caller
   *  can disclose the substitution — a fallback nobody is told about is how a
   *  broken toolchain gets reported as a success. */
  systemFallback?: SystemFallback;
  /** What we found when we looked for a local TeX. Carried even when the WASM
   *  backend ran, because the case that needs explaining most is "the bundled
   *  engine could not do this AND there is no local TeX" — where the reader is
   *  currently shown a raw LaTeX log line and left to work out the rest. */
  systemTex?: SystemTexProbe;
}

export interface CompileProjectOptions {
  projectRoot: string;
  mainFile?: string;
  engine?: Engine;
  backend?: Backend;
  /** Let the document run external programs. System backend only — the WASM
   *  engine has no subprocesses, so it is silently irrelevant there. */
  shellEscape?: boolean;
}

export async function compileProject(opts: CompileProjectOptions): Promise<CompileProjectResult> {
  const mainFile = await resolveMainFile(opts.projectRoot, opts.mainFile);

  // resolveMainFile has already established that this file exists inside the
  // project, so failing to read it now is a real failure — a permissions problem
  // or a broken link. It used to be swallowed: `mainSrc` stayed empty, every
  // heuristic below saw nothing, and the compile went ahead with pdflatex and no
  // bibliography pass and reported success over a PDF whose citations were all
  // `[?]`. An error the reader can act on is the only honest answer.
  let mainSrc: string;
  try {
    mainSrc = decodeTexBytes(await readFile(join(opts.projectRoot, mainFile)));
  } catch (e) {
    throw new MainFileError(`Could not read the main file ${mainFile}: ${(e as Error).message}`);
  }

  // The text sources are always collected, whichever backend runs.
  //
  // Every heuristic below — which engine, whether to run bibtex, whether to
  // rerun — used to look at the main file alone, which is only correct for a
  // one-file paper. A thesis whose \cite and \bibliography live in an \input-ed
  // chapter got no bibliography pass at all and rendered `[?]` for every
  // citation, with success=true, zero errors, and a clean checkpoint written
  // over it. Reading the .tex/.bib/.sty of a project is cheap; it was the
  // *figures* that cost 32.4 MB per save on a real IEEE paper, and those are
  // still deferred to the WASM path that actually needs them.
  const project = await collectProjectFiles(opts.projectRoot, { mainFile: mainFile, textOnly: true });
  const texSrc = concatTexSources(mainSrc, mainFile, project.files);

  const engine: Engine = opts.engine ?? detectEngine(texSrc);

  // Real-TeX backend: when forced ('system') or available under 'auto', latexmk
  // compiles the on-disk project directly — full package fidelity, no fallback
  // shims. 'system' with no local TeX is a clear error rather than a silent WASM
  // fallback (so the user knows their choice couldn't be honored).
  //
  // 'auto' is the default. The zero-install promise was that you don't *need* a
  // local TeX, not that we'd decline to use one: defaulting to wasm meant someone
  // with MacTeX on PATH silently got the bundled subset — no venue classes, no
  // `svg` — and output that doesn't match Overleaf, without ever being told a
  // better compiler was sitting right there.
  const backend: Backend = opts.backend ?? 'auto';
  let systemFallback: CompileProjectResult['systemFallback'];
  // Hoisted out of the system branch because it still has to be said when
  // 'auto' falls through to the bundled engine: the reason the local TeX did not
  // get there is exactly what this note explains.
  let sysNotes: string[] = [];
  // Probed once here and reused: the two ways of being unusable need different
  // answers from the reader, and "latexmk is on PATH but cannot run" reported as
  // "no local TeX was found" is what sent a user off to install a distribution
  // they already had.
  const sysProbe = await probeSystemTex();
  const wantSystem = backend === 'system' || (backend === 'auto' && sysProbe.usable);
  if (wantSystem) {
    // How big the project is, for the caller's summary. The text collection
    // above already walked and stat'ed the whole tree, so its counts describe
    // every file including the binaries it deliberately did not read.
    const size = { count: project.count, truncated: project.truncated };
    if (backend === 'system' && !sysProbe.usable) {
      return { success: false, pdf: undefined, pdfLen: 0, log: '', ms: 0, error: systemTexUnavailableMessage(sysProbe), mainFile, engine, backend: 'system', fileCount: size.count, truncated: size.truncated };
    }
    // The project's own input directories go on the TeX search path. kpathsea
    // does not look inside a project's subdirectories, so without this a paper
    // shipping `styles/myvenue.cls` or `bib/refs.bib` fails on the local backend
    // while compiling fine on the bundled one — the opposite of what "full
    // fidelity" is supposed to mean. Derived from the walk already done above.
    const searchDirs = searchPathDirs(project.files.map((f) => f.path), mainFile);
    const out = await compileWithSystemTex(opts.projectRoot, mainFile, engine, opts.shellEscape ?? false, searchDirs);
    const sysVerdict = classifyCompile(out.log ?? '', out.pdfLen);
    // The engine ran with MiKTeX's installer switched off (it was set to ask,
    // and there is nobody here to answer its dialog), and the document then
    // wanted something this machine does not have. Say so: otherwise this looks
    // like a package that cannot be had, when it is one command away.
    sysNotes = out.installerDisabled
      && (sysVerdict.missingPackages.length || sysVerdict.missingClasses.length)
      ? [MIKTEX_ASK_NOTE]
      : [];

    // Keep the system result whenever it produced something usable — a real TeX
    // with warnings still beats the bundled subset for fidelity.
    //
    // Judged from the log, not from the exit status. latexmk exits 12 on any
    // ordinary LaTeX error even under -f, so requiring `out.success` here meant
    // one typo in a paper that typeset every page perfectly was treated as "the
    // local TeX produced nothing" — and under `auto` the whole compile silently
    // moved to the bundled engine. `success` now means the same thing on both
    // backends: a PDF worth showing came out, errors and all.
    if (sysVerdict.usable) {
      return { ...out, success: true, verdict: sysVerdict, notes: sysNotes, mainFile, engine, backend: 'system', fileCount: size.count, truncated: size.truncated };
    }

    // Forced 'system' does not fall back. Asking for that backend is a statement
    // that you want that toolchain or an error; quietly substituting another one
    // would answer a question nobody asked.
    if (backend === 'system') {
      return { ...out, success: false, verdict: sysVerdict, notes: sysNotes, mainFile, engine, backend: 'system', fileCount: size.count, truncated: size.truncated };
    }

    // 'auto': the local TeX couldn't produce a PDF, so continue to the bundled
    // engine — but carry why, so the substitution gets disclosed rather than
    // showing up as an unexplained success on a different toolchain.
    systemFallback = {
      errors: sysVerdict.errors.slice(0, 3),
      missingPackages: sysVerdict.missingPackages,
      missingClasses: sysVerdict.missingClasses,
      blockedTools: sysVerdict.blockedTools,
    };
  }

  // The bundled engine runs from here, and it is handed every file — figures
  // included — so this is where the rest of the project has to be read.
  const collected = await collectProjectFiles(opts.projectRoot, { mainFile: mainFile });
  const { files, truncated } = collected;

  // Inject bundled fallback .sty for packages busytex omits — but only those the
  // project doesn't already ship (a project's own copy always wins).
  const aliases = flattenedClassAliases(files);
  const present = new Set([...files, ...aliases].map((f) => f.path.split('/').pop()));
  const fallbacks = (await getFallbackStyles()).filter((f) => !present.has(f.path));
  const allFiles = [...files, ...aliases, ...fallbacks];

  const { bibtex, rerun: needsRerun } = bibPasses(texSrc, allFiles.map((f) => f.path));

  const notes: string[] = [...sysNotes];
  const biblatex = biblatexWasmNote(texSrc);
  if (biblatex) notes.push(biblatex);
  // Truncation is disclosed here rather than only in the caller's clean-success
  // line, because the compile most likely to be truncated is the one most likely
  // to fail — and the failure branch never mentioned it at all.
  if (truncated) notes.push(truncationNote(collected.skippedFiles, collected.skippedBytes));

  let out = await compile(allFiles, mainFile, engine, { bibtex, rerun: needsRerun });
  let verdict = classifyCompile(out.log ?? '', out.pdfLen);
  let stubbed: string[] = [];

  // A `\usepackage` the bundled TeX Live lacks halts the whole document — even
  // when nothing in it uses that package, which is the usual case for an import
  // left behind after its figures or code were removed. Stub those and retry
  // once, so a stale line in the preamble can't cost the author their preview.
  // Packages the source really does use are left alone: failing is better than
  // silently rendering something different from what they wrote.
  if (verdict.fatal && verdict.missingPackages.length) {
    const unused = verdict.missingPackages.filter((p) => !usesPackage(p, texSrc));
    if (unused.length) {
      const stubs = unused.map((p) => ({ path: `${p}.sty`, content: stubPackage(p), encoding: 'utf8' as const }));
      const retryOut = await compile([...allFiles, ...stubs], mainFile, engine, { bibtex, rerun: needsRerun });
      const retryVerdict = classifyCompile(retryOut.log ?? '', retryOut.pdfLen);
      // Keep the retry only if it actually got further; otherwise report the
      // original failure, which is the more informative one.
      if (retryVerdict.usable || !retryVerdict.fatal) {
        out = retryOut;
        verdict = retryVerdict;
        stubbed = unused;
      }
    }
  }

  return {
    ...out,
    // busytex says success even when LaTeX stopped on an error; the log is the
    // only honest signal. Downstream uses this to decide whether to replace the
    // reader's PDF and whether to write a checkpoint.
    success: verdict.usable,
    verdict,
    stubbedPackages: stubbed,
    notes,
    systemTex: sysProbe,
    systemFallback,
    mainFile,
    engine,
    backend: 'wasm',
    fileCount: files.length,
    truncated,
  };
}

// The citation commands a paper actually uses. `\cite` alone missed every
// natbib and biblatex document — \citep, \citet, \parencite, \autocite — so the
// bibliography pass was skipped on exactly the papers that have one. The
// optional-argument form `\cite[p.~3]{key}` needs the `[` alternative.
const CITE_COMMANDS = /\\(?:cite|citep|citet|parencite|textcite|autocite|nocite)[a-zA-Z]*\s*[[{]/;
// Anything whose value is only known after a first pass has written the .aux:
// cross-references, contents lists, indexes, glossaries.
const RERUN_TRIGGERS =
  /\\(?:ref|autoref|cref|Cref|eqref|pageref|nameref|label|tableofcontents|listoffigures|listoftables|printindex|makeindex|index|printglossar[a-zA-Z]*|glsadd|gls[a-zA-Z]*)\b/;
const BIBLATEX = /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*biblatex/;
const TEX_SOURCE = /\.(?:tex|ltx|sty|cls)$/i;

/**
 * Everything the heuristics get to read: the main file first, then every other
 * TeX source in the project.
 *
 * Main file first so an editor magic comment in the root wins over one in a
 * chapter, and so the `%&` format specifier — which is only meaningful as the
 * very first line of a file — is anchored to the right file.
 */
function concatTexSources(mainSrc: string, mainRel: string, textFiles: EngineFile[]): string {
  const rest = textFiles
    .filter((f) => f.path !== mainRel && TEX_SOURCE.test(f.path))
    .map(decodeForHeuristics);
  return [mainSrc, ...rest].join('\n');
}

/**
 * Text for pattern-matching only — never for the engine, which gets the original
 * bytes. A source that isn't UTF-8 is carried as base64 (see
 * `collectProjectFiles`), and leaving it undecoded would hide a whole Latin-1 or
 * UTF-16 paper from every heuristic here. Latin-1 is the right guess for the
 * remainder because TeX control sequences are ASCII either way.
 */
function decodeForHeuristics(file: EngineFile): string {
  return file.encoding === 'base64' ? decodeTexBytes(Buffer.from(file.content, 'base64')) : file.content;
}

function decodeTexBytes(buf: Buffer): string {
  if (buf.length >= 2 && buf.length % 2 === 0) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
    if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf).swap16().toString('utf16le').slice(1);
  }
  const text = buf.toString('utf8');
  // U+FFFD means the bytes were not UTF-8 at all; Latin-1 at least round-trips
  // the ASCII the patterns here are looking for.
  return text.includes('�') ? buf.toString('latin1') : text;
}

/**
 * Which extra passes this document needs: a bibliography run, and a rerun to
 * resolve what the first pass only wrote down.
 *
 * Reading the whole project rather than the root file is the point. Both of
 * these used to be decided from the main file alone, so a thesis whose \cite and
 * \bibliography live in an \input-ed chapter got neither — `[?]` for every
 * citation, `??` for every reference, an empty table of contents, and a
 * successful compile with zero errors reported over it.
 */
export function bibPasses(texSrc: string, paths: string[]): { bibtex: boolean; rerun: boolean } {
  const hasBibCmd = /\\(bibliography|addbibresource)\b/.test(texSrc);
  const usesCite = CITE_COMMANDS.test(texSrc);
  const lower = paths.map((p) => p.toLowerCase());
  const hasBibFile = lower.some((p) => p.endsWith('.bib'));
  const hasBbl = lower.some((p) => p.endsWith('.bbl'));
  // All three conditions, and the third is the one that was missing. arXiv
  // sources ship a finished `.bbl` and no `.bib`; running bibtex8 on them finds
  // no database, writes an *empty* .bbl over the shipped one, and the paper
  // renders with an empty References section and `[?]` for every citation —
  // strictly worse than not running it at all.
  const bibtex = hasBibCmd && usesCite && hasBibFile;
  // A shipped .bbl is only read on the second LaTeX pass, so it needs the rerun
  // the absent bibtex run would otherwise have justified.
  return { bibtex, rerun: bibtex || hasBbl || hasBibCmd || RERUN_TRIGGERS.test(texSrc) };
}

/**
 * A .cls/.sty/.bst shipped in a subdirectory, offered again at the root.
 *
 * `styles/myvenue.cls` is collected and handed to the engine, and TeX then does
 * not find it: kpathsea searches its own trees and the current directory, not
 * the project's subdirectories, so `\documentclass{myvenue}` fails with "class
 * not found" while the file is demonstrably right there. On a real machine the
 * project's TEXINPUTS would cover this; in the bundled engine an alias at the
 * root is the equivalent. A root-level file of the same name always wins.
 */
export function flattenedClassAliases(files: EngineFile[]): EngineFile[] {
  const CLASS_LIKE = /\.(?:cls|sty|bst)$/i;
  const atRoot = new Set(files.filter((f) => !f.path.includes('/')).map((f) => f.path.toLowerCase()));
  const aliases: EngineFile[] = [];
  const added = new Set<string>();
  for (const f of files) {
    if (!f.path.includes('/') || !CLASS_LIKE.test(f.path)) continue;
    const name = f.path.slice(f.path.lastIndexOf('/') + 1);
    const key = name.toLowerCase();
    if (atRoot.has(key) || added.has(key)) continue;
    added.add(key);
    aliases.push({ ...f, path: name });
  }
  return aliases;
}

/**
 * biblatex on the bundled engine, which has bibtex8 and no biber.
 *
 * The compile succeeds, the log carries no error, and the PDF comes out with
 * every citation as a raw key and no bibliography — a failure that looks exactly
 * like a success unless you read the References section. Say so before the
 * reader goes looking for the mistake in their own source.
 */
export function biblatexWasmNote(texSrc: string): string | undefined {
  if (!BIBLATEX.test(texSrc)) return undefined;
  return 'This paper uses biblatex, which needs biber; the bundled engine only has bibtex8, so citations will show as raw keys and the bibliography will be missing. A local TeX install renders it correctly (TeXChronicle uses one automatically), or switch to natbib + bibtex.';
}

/** What the caps left out, said plainly. A silently shortened project is how a
 *  missing figure becomes an hour of looking for a typo in the \includegraphics
 *  path that was never wrong. */
export function truncationNote(skippedFiles: number, skippedBytes: number): string {
  // In MB to match the cap it is being measured against, unless that would round
  // to "0.0 MB" — which is what hitting the *file* cap with small files looks
  // like, and reads as a bug rather than an explanation.
  const size = skippedBytes >= 1024 * 1024
    ? `${(skippedBytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(skippedBytes / 1024)} KB`;
  return `Project too large for the bundled engine — ${skippedFiles} files / ${size} were skipped after the cap (800 files / 60 MB). Text sources were kept; if a figure is missing from the PDF this is why.`;
}

// Pick an engine from the preamble. Ordinary LaTeX and pdfTeX-specific commands
// belong on pdfLaTeX; fontspec/unicode-math require Xe/Lua. An editor magic
// comment wins when the author supplied one. The old implementation returned
// xelatex for every document, which made an unguarded glyphtounicode preamble
// fail with hundreds of undefined \pdfglyphtounicode commands.
//
// Fed every TeX source in the project, not only the root: `\usepackage{fontspec}`
// in an \input-ed preamble file is still a document that cannot compile on
// pdfLaTeX, and detecting it from the root alone got that wrong on any paper
// organised the way large ones usually are.
export function detectEngine(src: string): Engine {
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  // Case-insensitive on the value as well as the keyword: TeXShop and TeXstudio
  // write `% !TEX program = XeLaTeX`, and comparing the capture against a
  // lowercase literal quietly dropped every one of them back to pdflatex.
  const declared = text.match(/^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(pdf|xe|lua)latex\b/im)?.[1]?.toLowerCase()
    // TeX's own format specifier, which must be the file's first line — hence no
    // /m flag: anchored to the start of the main source, not to any line of it.
    ?? /^%&\s*(pdf|xe|lua)latex\b/i.exec(text)?.[1]?.toLowerCase();
  if (declared === 'pdf') return 'pdflatex';
  if (declared === 'lua') return 'lualatex';
  if (declared === 'xe') return 'xelatex';

  // Ignore disabled package lines. This intentionally stays lightweight: it is
  // an engine hint, not a TeX parser.
  const active = text.replace(/(^|[^\\])%.*/gm, '$1');
  if (/\\(?:directlua|luatexversion)\b/.test(active)
      || /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*(?:luacode|luaotfload|luatexja)[^}]*\}/.test(active)) {
    return 'lualatex';
  }
  if (/\\XeTeX\w*/.test(active)
      || /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*(?:fontspec|unicode-math|mathspec|xltxtra|xunicode|polyglossia|xeCJK|xecjk)[^}]*\}/.test(active)) {
    return 'xelatex';
  }
  return 'pdflatex';
}
