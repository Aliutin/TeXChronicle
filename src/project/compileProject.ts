// The one shared compile path: resolve main file -> gather project -> compile.
// Both the render_preview MCP tool and (later) the file watcher call this.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveMainFile } from './resolveMainFile.js';
import { collectProjectFiles, countProjectFiles, type CollectResult } from './collectProjectFiles.js';
import { getFallbackStyles } from '../engine/fallbackStyles.js';
import { compile, type CompileOutput } from '../engine/browserHost.js';
import { probeSystemTex, compileWithSystemTex, systemTexUnavailableMessage, type SystemTexProbe, type SystemFallback } from '../engine/systemTex.js';
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

  // Deferred, because only the WASM engine needs it: it is handed every file as
  // a string, so the whole project has to be in memory. latexmk is given a
  // directory and reads from disk itself, so collecting for the system backend
  // meant reading 32.4 MB of a real IEEE paper — author photos and all, capped
  // at 60 MB — on every save, and dropping it on the floor.
  let collected: CollectResult | undefined;
  const collect = async (): Promise<CollectResult> => (collected ??= await collectProjectFiles(opts.projectRoot));

  // Engine detection needs the main source and nothing else.
  let mainRel = mainFile;
  let mainSrc = '';
  try {
    mainSrc = await readFile(join(opts.projectRoot, mainFile), 'utf8');
  } catch {
    // An explicit mainFile can name something nested, which resolveMainFile
    // passes through untouched. Walking the project is the only way to find it —
    // the same lookup as before, now only in the case that needs it.
    const found = (await collect()).files.find((f) => f.path === mainFile || f.path.endsWith('/' + mainFile));
    if (found) { mainRel = found.path; mainSrc = found.content ?? ''; }
  }
  const engine: Engine = opts.engine ?? detectEngine(mainSrc);

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
  // Probed once here and reused: the two ways of being unusable need different
  // answers from the reader, and "latexmk is on PATH but cannot run" reported as
  // "no local TeX was found" is what sent a user off to install a distribution
  // they already had.
  const sysProbe = await probeSystemTex();
  const wantSystem = backend === 'system' || (backend === 'auto' && sysProbe.usable);
  if (wantSystem) {
    // How big the project is, for the caller's summary. Stats only — the system
    // backend never needed the contents, and reading them was the waste this
    // deferral removes. Reuses the collection when something already forced it.
    const size = collected
      ? { count: collected.files.length, truncated: collected.truncated }
      : await countProjectFiles(opts.projectRoot);
    if (backend === 'system' && !sysProbe.usable) {
      return { success: false, pdf: undefined, pdfLen: 0, log: '', ms: 0, error: systemTexUnavailableMessage(sysProbe), mainFile, engine, backend: 'system', fileCount: size.count, truncated: size.truncated };
    }
    const out = await compileWithSystemTex(opts.projectRoot, mainRel, engine, opts.shellEscape ?? false);
    const sysVerdict = classifyCompile(out.log ?? '', out.pdfLen);

    // Keep the system result whenever it produced something usable — a real TeX
    // with warnings still beats the bundled subset for fidelity.
    if (out.success && sysVerdict.usable) {
      return { ...out, verdict: sysVerdict, mainFile, engine, backend: 'system', fileCount: size.count, truncated: size.truncated };
    }

    // Forced 'system' does not fall back. Asking for that backend is a statement
    // that you want that toolchain or an error; quietly substituting another one
    // would answer a question nobody asked.
    if (backend === 'system') {
      return { ...out, success: false, verdict: sysVerdict, mainFile, engine, backend: 'system', fileCount: size.count, truncated: size.truncated };
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

  // The bundled engine runs from here, and it is handed every file, so this is
  // where the project actually has to be read.
  const { files, truncated } = await collect();

  // Inject bundled fallback .sty for packages busytex omits — but only those the
  // project doesn't already ship (a project's own copy always wins).
  const present = new Set(files.map((f) => f.path.split('/').pop()));
  const fallbacks = (await getFallbackStyles()).filter((f) => !present.has(f.path));
  const allFiles = fallbacks.length ? [...files, ...fallbacks] : files;

  // Enable a bib pass + reruns only when the document actually needs them —
  // avoids paying for extra passes on a simple doc.
  const hasBib = /\\(bibliography|addbibresource)\b/.test(mainSrc) || allFiles.some((f) => f.path.endsWith('.bib'));
  const usesCite = /\\cite[a-zA-Z]*\s*\{/.test(mainSrc);
  const needsRerun = hasBib || /\\(ref|autoref|tableofcontents|label)\b/.test(mainSrc);
  const bibtex = hasBib && usesCite;

  let out = await compile(allFiles, mainRel, engine, { bibtex, rerun: needsRerun });
  let verdict = classifyCompile(out.log ?? '', out.pdfLen);
  let stubbed: string[] = [];

  // A `\usepackage` the bundled TeX Live lacks halts the whole document — even
  // when nothing in it uses that package, which is the usual case for an import
  // left behind after its figures or code were removed. Stub those and retry
  // once, so a stale line in the preamble can't cost the author their preview.
  // Packages the source really does use are left alone: failing is better than
  // silently rendering something different from what they wrote.
  if (verdict.fatal && verdict.missingPackages.length) {
    const unused = verdict.missingPackages.filter((p) => !usesPackage(p, mainSrc));
    if (unused.length) {
      const stubs = unused.map((p) => ({ path: `${p}.sty`, content: stubPackage(p), encoding: 'utf8' as const }));
      const retryOut = await compile([...allFiles, ...stubs], mainRel, engine, { bibtex, rerun: needsRerun });
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
    systemTex: sysProbe,
    systemFallback,
    mainFile,
    engine,
    backend: 'wasm',
    fileCount: files.length,
    truncated,
  };
}

// Pick an engine from the preamble. Ordinary LaTeX and pdfTeX-specific commands
// belong on pdfLaTeX; fontspec/unicode-math require Xe/Lua. An editor magic
// comment wins when the author supplied one. The old implementation returned
// xelatex for every document, which made an unguarded glyphtounicode preamble
// fail with hundreds of undefined \pdfglyphtounicode commands.
export function detectEngine(src: string): Engine {
  const declared = src.match(/^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(pdf|xe|lua)latex\b/im)?.[1];
  if (declared === 'pdf') return 'pdflatex';
  if (declared === 'lua') return 'lualatex';
  if (declared === 'xe') return 'xelatex';

  // Ignore disabled package lines. This intentionally stays lightweight: it is
  // an engine hint, not a TeX parser, and only the main preamble is inspected.
  const active = src.replace(/(^|[^\\])%.*/gm, '$1');
  if (/\\(?:directlua|luatexversion)\b/.test(active)
      || /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*(?:luacode|luaotfload)[^}]*\}/.test(active)) {
    return 'lualatex';
  }
  if (/\\XeTeX\w*/.test(active)
      || /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*(?:fontspec|unicode-math|mathspec|xltxtra|xunicode)[^}]*\}/.test(active)) {
    return 'xelatex';
  }
  return 'pdflatex';
}
