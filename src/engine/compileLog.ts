// Reading the TeX log is the only honest way to know what happened.
//
// busytex reports success: true even when LaTeX stopped on an error, so trusting
// that flag published truncated PDFs over good previews and wrote them into the
// checkpoint history as if they were fine. What the log actually contains — the
// per-tool EXITCODE lines, `! ... Error`, `Emergency stop`, `No pages of output`
// — is the ground truth, so classify from that instead.
//
// The distinction that matters is fatal vs. imperfect. LaTeX routinely emits
// errors and still produces a readable PDF; Overleaf shows you that PDF next to
// an error list rather than hiding it. Only a run that produced nothing usable
// should keep the previous preview in place.

export type CompileVerdict = {
  /** A PDF worth showing came out — even if the run also reported errors. */
  usable: boolean;
  /** LaTeX stopped rather than finishing the document. */
  fatal: boolean;
  /** `! ...` error lines, deduped, in order. */
  errors: string[];
  /** Packages LaTeX couldn't find: `File \`X.sty' not found`. */
  missingPackages: string[];
  /** Document classes LaTeX couldn't find — these can't be stubbed away. */
  missingClasses: string[];
  /** External programs the document tried to run and was refused. Tracked apart
   *  from the errors because the fix depends entirely on which backend ran. */
  blockedTools: string[];
};

/**
 * Documents that shell out: `svg` runs Inkscape, `minted` runs Pygments,
 * `gnuplottex` runs gnuplot. Every one of them surfaces as a *missing file*,
 * which is the least useful description available — the file is missing because
 * the program that writes it was never allowed to run.
 *
 * Patterns lifted from a real failing log, not written from memory. A detection
 * string that doesn't match is a feature that silently doesn't exist.
 */
const BLOCKED_TOOL_SIGNS: [RegExp, string][] = [
  [/wasn't possible to launch the Inkscape export/i, 'Inkscape'],
  [/Package svg Error: File `.*_svg-tex\.pdf' is missing/i, 'Inkscape'],
  [/Package minted Error: You must invoke LaTeX with the -shell-escape flag/i, 'Pygments'],
  [/runsystem\([^)]*\)\.{3}disabled/i, 'an external program'],
];

/**
 * What to do about a refused external program — which is a different answer on
 * each backend, and that difference is the whole reason this exists.
 *
 * The bundled engine has no subprocesses at all, so telling a WASM user to
 * enable shell-escape sends them to do something that cannot possibly help. It
 * would be the same shape of mistake as naming `latexmk` and stopping.
 *
 * The pre-export route leads on wasm and trails on system because it is the only
 * one that works on both, and it removes a build dependency instead of adding
 * one.
 */
export function blockedToolHelp(tools: string[], backend: 'wasm' | 'system', shellEscape: boolean): string {
  if (!tools.length) return '';
  const what = tools.join(' and ');
  if (backend === 'wasm') {
    return `This document runs ${what} to build a figure, and the bundled WASM engine cannot run external programs at all — it has no subprocesses, so no flag will enable it.\n\nExport the figure to PDF once and use \\includegraphics, which needs nothing at build time. Or compile with backend: "system" and shellEscape: true, on a machine that has ${what} installed.`;
  }
  if (!shellEscape) {
    return `This document runs ${what} to build a figure, which LaTeX refuses unless shell-escape is on.\n\nRe-run with shellEscape: true — note that this lets the document execute shell commands, so only use it on sources you trust. Or export the figure to PDF once and use \\includegraphics, which needs neither shell-escape nor ${what}.`;
  }
  return `Shell-escape is on, so LaTeX was allowed to run ${what}, but the run still failed — most likely ${what} isn't installed or isn't on PATH. Installing it fixes this; exporting the figure to PDF once and using \\includegraphics avoids needing it at all.`;
}

const FATAL = [
  /^!\s*Emergency stop/m,
  /No pages of output/,
  /Fatal error occurred/,
];

/** `EXITCODE: n` lines, one per tool the pipeline ran (xelatex, bibtex, …). */
function exitCodes(log: string): number[] {
  return [...log.matchAll(/^EXITCODE:\s*(\d+)/gm)].map((m) => Number(m[1]));
}

export function classifyCompile(log: string, pdfLen: number): CompileVerdict {
  const errors = [...new Set(
    [...log.matchAll(/^!\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean),
  )];

  const missing = (ext: 'sty' | 'cls') =>
    [...new Set(
      [...log.matchAll(new RegExp(String.raw`File \`([^'\\\/]+)\.${ext}' not found`, 'g'))].map((m) => m[1]),
    )];

  const fatal = FATAL.some((re) => re.test(log));

  // A bibtex run failing (exit 3 because no .aux exists) is a symptom of the
  // LaTeX run dying, not an independent fatal condition — the error list and
  // the missing PDF already say so. Only judge fatality from the signatures
  // above plus whether anything came out.
  return {
    usable: pdfLen > 0 && !fatal,
    fatal: fatal || pdfLen === 0,
    errors,
    missingPackages: missing('sty'),
    missingClasses: missing('cls'),
    blockedTools: [...new Set(BLOCKED_TOOL_SIGNS.filter(([re]) => re.test(log)).map(([, tool]) => tool))],
  };
}

/**
 * A do-nothing .sty so a package the bundled TeX Live lacks can't halt a
 * document that never actually uses it — the common case being a `\usepackage`
 * left behind after the code that needed it was deleted or commented out.
 *
 * Stubbing is only safe when the package is unused; `usesPackage` decides that,
 * and every stub is reported so the output is never quietly different without
 * the user being told.
 */
export function stubPackage(name: string): string {
  return [
    `\\NeedsTeXFormat{LaTeX2e}`,
    `\\ProvidesPackage{${name}}[0000/00/00 stub injected by TeXChronicle]`,
    `% The bundled TeX Live subset has no ${name}.sty. Nothing in this document`,
    `% appeared to use it, so it is stubbed out rather than halting the compile.`,
    `% For full package fidelity, compile with backend: "system".`,
    `\\endinput`,
    '',
  ].join('\n');
}

/**
 * Does the source plausibly use this package? Deliberately conservative: a
 * false "yes" only costs us the retry (the compile fails as it would have
 * anyway), while a false "no" would stub something load-bearing and silently
 * change the output.
 */
export function usesPackage(name: string, src: string): boolean {
  // Commands whose names embed the package are the strongest signal, and cover
  // the packages users actually hit: \includesvg, \includepdf, \subfile, …
  if (new RegExp(String.raw`\\[a-zA-Z]*${escapeRe(name)}[a-zA-Z]*\s*[\[{]`, 'i').test(src)) return true;
  // Environments named after it: \begin{algorithm}, \begin{tikzpicture}, …
  if (new RegExp(String.raw`\\begin\{${escapeRe(name)}`, 'i').test(src)) return true;
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
