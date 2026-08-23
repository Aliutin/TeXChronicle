// Real-TeX backend: compile with a locally installed TeX Live via latexmk, for
// 100% package fidelity (the WASM engine ships a subset). Used by default under
// backend 'auto' when a local TeX is present; 'system' forces it, 'wasm' opts
// out and keeps the zero-install path.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, mkdir } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import type { CompileOutput } from './browserHost.js';
import type { Engine } from '../project/compileProject.js';

const pexec = promisify(execFile);

interface LatexmkLaunch {
  command: string;
  prefixArgs: string[];
  env?: NodeJS.ProcessEnv;
}

const pathLaunch = (): LatexmkLaunch => ({ command: 'latexmk', prefixArgs: [] });
let latexmkLaunch = pathLaunch();

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function childEnvWithPath(prepend: string[]): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  const inherited = process.env[pathKey] ?? '';
  return {
    ...process.env,
    [pathKey]: [...new Set([...prepend, inherited].filter(Boolean))].join(delimiter),
  };
}

/**
 * Windows installers broadcast a PATH update, but an already-running MCP/app
 * process keeps the old environment. MiKTeX also commonly lives in its default
 * per-user directory without being on PATH at all. Discover the two standard
 * installations and, when both are present, run MiKTeX's latexmk script with
 * Strawberry Perl directly. This makes an install made mid-session usable after
 * the next probe instead of requiring a reboot or manual PATH surgery.
 */
async function windowsLatexmkLaunches(): Promise<LatexmkLaunch[]> {
  if (process.platform !== 'win32') return [];

  const local = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programW6432 = process.env.ProgramW6432;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const programData = process.env.ProgramData;
  const systemDrive = process.env.SystemDrive ?? (process.env.SystemRoot?.slice(0, 2) || 'C:');

  const perlPaths = [
    join(systemDrive, 'Strawberry', 'perl', 'bin', 'perl.exe'),
    local ? join(local, 'Programs', 'Strawberry', 'perl', 'bin', 'perl.exe') : '',
    programFiles ? join(programFiles, 'Strawberry Perl', 'perl', 'bin', 'perl.exe') : '',
    programW6432 ? join(programW6432, 'Strawberry Perl', 'perl', 'bin', 'perl.exe') : '',
  ].filter(Boolean);
  const perls: string[] = [];
  for (const perl of [...new Set(perlPaths)]) if (await exists(perl)) perls.push(perl);
  if (!perls.length) return [];

  const launches: LatexmkLaunch[] = [];
  // First retry whatever latexmk the process already knows, but with newly
  // installed Strawberry directories visible to MiKTeX's script-engine lookup.
  for (const perl of perls) {
    const strawberry = dirname(dirname(dirname(perl)));
    launches.push({
      command: 'latexmk',
      prefixArgs: [],
      env: childEnvWithPath([
        dirname(perl),
        join(strawberry, 'perl', 'site', 'bin'),
        join(strawberry, 'c', 'bin'),
      ]),
    });
  }

  const miktexRoots = [
    local ? join(local, 'Programs', 'MiKTeX') : '',
    programFiles ? join(programFiles, 'MiKTeX') : '',
    programW6432 ? join(programW6432, 'MiKTeX') : '',
    programFilesX86 ? join(programFilesX86, 'MiKTeX') : '',
    programData ? join(programData, 'MiKTeX') : '',
  ].filter(Boolean);
  for (const root of [...new Set(miktexRoots)]) {
    const script = join(root, 'scripts', 'latexmk', 'latexmk.pl');
    if (!(await exists(script))) continue;
    const binCandidates = [join(root, 'miktex', 'bin', 'x64'), join(root, 'miktex', 'bin')];
    const miktexBin = (await Promise.all(binCandidates.map(async (path) => [path, await exists(path)] as const)))
      .find(([, present]) => present)?.[0];
    if (!miktexBin) continue;
    for (const perl of perls) {
      const strawberry = dirname(dirname(dirname(perl)));
      launches.push({
        command: perl,
        prefixArgs: [script],
        env: childEnvWithPath([
          miktexBin,
          dirname(perl),
          join(strawberry, 'perl', 'site', 'bin'),
          join(strawberry, 'c', 'bin'),
        ]),
      });
    }
  }
  return launches;
}

/**
 * What to tell someone who turns out not to have a local TeX.
 *
 * Naming `latexmk` on its own actively misleads: it is not separately
 * installable, it is a Perl driver that ships inside TeX Live. Someone reading
 * "latexmk was not found" goes looking for a package by that name and finds
 * nothing that helps — this happened, and the user came back asking whether they
 * needed "latexmk or the mactex pkg". So name the distribution instead, and say
 * plainly that they may not need one at all.
 */
export const INSTALL_TEX_HELP = [
  "latexmk isn't installed on its own — it ships with a TeX distribution:",
  '  macOS    MacTeX          https://tug.org/mactex/',
  '  Linux    texlive-full    (via your package manager)',
  '  Windows  TeX Live        https://tug.org/texlive/',
  '',
  // Named because it is the common Windows distribution and the one that leaves
  // a latexmk which cannot run: it is a Perl script and MiKTeX ships no Perl.
  // Someone who already has MiKTeX and is told only "install TeX Live" reads
  // that as advice they have already followed.
  'On Windows MiKTeX also works, but only with Perl alongside it —',
  'https://strawberryperl.com/ — because latexmk is a Perl script and MiKTeX',
  'does not ship one. Check with `latexmk -version`, not `which latexmk`: the',
  'file is on PATH either way, and only one of those tells you it can run.',
  '',
  "You don't need one to use MagicTeX: the bundled WASM engine compiles with no",
  'install at all. But it is a subset of TeX Live, so packages like `svg` and most',
  "venue classes aren't in it. Install a distribution when you need output that",
  'matches Overleaf exactly.',
].join('\n');

/**
 * The `\usepackage` name is not always the name you install. `tlmgr install
 * algorithm` fails; the bundle is `algorithms`. Handing someone a command that
 * errors is worse than handing them nothing, so map the cases where the two
 * differ and pass everything else through unchanged.
 */
const CTAN_BUNDLE: Record<string, string> = {
  algorithm: 'algorithms',
  algorithmic: 'algorithms',
  algpseudocode: 'algorithmicx',
  algorithmicx: 'algorithmicx',
  IEEEtran: 'ieeetran',
  llncs: 'llncs',
};

export interface SystemFallback {
  errors: string[];
  missingPackages: string[];
  missingClasses: string[];
  /** Tools the document needs that LaTeX refused to run (svg -> Inkscape,
   *  minted -> Pygments). Carried because this is how a real paper's local-TeX
   *  run actually failed, and without it the caller could say only "it failed
   *  for a different reason" and then trail off — classifyCompile files these
   *  under blockedTools, not errors, so `errors` came back empty. */
  blockedTools?: string[];
}

/**
 * Explain a backend substitution in terms the reader can act on: what their own
 * TeX choked on, what they are looking at instead, and the one command that
 * closes the gap.
 *
 * Without this, `auto` falling back to WASM is indistinguishable from a clean
 * success on the toolchain they configured — which is how a minimal BasicTeX
 * install got reported as "Compile succeeded" while quietly producing output
 * from a different TeX Live than the author believed they were using.
 */
export function systemFallbackNote(f: SystemFallback): string {
  const missing = [...f.missingPackages, ...f.missingClasses];
  const why = missing.length
    ? `${missing.map((m) => `\`${m}\``).join(', ')} not found`
    : (f.errors[0] ?? 'it produced no PDF');
  const packages = [...new Set(missing.map((m) => CTAN_BUNDLE[m] ?? m))];
  const fix = packages.length
    ? `\n\nTo compile with your own TeX instead:\n  tlmgr install ${packages.join(' ')}\n(prefix with sudo on a system-wide TeX Live)`
    : '';
  return `Your local TeX was tried first and failed — ${why}. Fell back to the bundled WASM engine, which got through it, so this PDF exists — but it came from a subset of TeX Live and may not match Overleaf.${fix}`;
}

/**
 * Why the local TeX could not be used. `'absent'` and `'broken'` are different
 * problems with opposite answers, and collapsing them cost a real afternoon: a
 * user installed MiKTeX, MagicTeX went on saying no local TeX was found, and an
 * agent eventually gave up and invoked the compiler itself.
 */
export interface SystemTexProbe {
  usable: boolean;
  reason?: 'absent' | 'broken';
  /** What the OS or the tool actually said. The most useful line available here
   *  is produced by MiKTeX, and used to be discarded by a bare catch. */
  detail?: string;
}

let probe: SystemTexProbe | undefined;

/** Is `latexmk` present AND able to run? */
export async function probeSystemTex(): Promise<SystemTexProbe> {
  // Only a negative result is re-checked, and only that one can change under us:
  // people install TeX while the server is running — often *because* we just
  // told them a package was missing — and this is a long-lived stdio process.
  // A permanent memo meant that install never took effect for the rest of the
  // session, and `backend: "system"` kept reporting "no local TeX was found"
  // about a latexmk sitting on PATH.
  //
  // A positive result is kept: TeX does not uninstall itself mid-session, and
  // re-probing before every compile would spawn a process for nothing.
  if (probe?.usable) return probe;
  const launches = [pathLaunch(), ...(await windowsLatexmkLaunches())];
  let failure: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | undefined;
  for (const launch of launches) {
    try {
      await pexec(launch.command, [...launch.prefixArgs, '-version'], { timeout: 6000, env: launch.env });
      latexmkLaunch = launch;
      probe = { usable: true };
      return probe;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      // Prefer a failure from something that really existed over ENOENT: it
      // carries the actionable MiKTeX/Perl message instead of "not found".
      if (!failure || failure.code === 'ENOENT' || err.code !== 'ENOENT') failure = err;
    }
  }

  const err = (failure ?? Object.assign(new Error('latexmk was not found'), { code: 'ENOENT' })) as
    NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  // ENOENT is "no such executable". Anything else means latexmk was found and
  // failed to run. Reported as "not found", that sends people off to install a
  // distribution they already have.
  const absent = err.code === 'ENOENT';
  const said = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim();
  latexmkLaunch = pathLaunch();
  probe = {
    usable: false,
    reason: absent ? 'absent' : 'broken',
    detail: absent ? undefined : said.slice(0, 600) || undefined,
  };
  return probe;
}

/** Is a usable local TeX (latexmk) on PATH? */
export async function hasSystemTex(): Promise<boolean> {
  return (await probeSystemTex()).usable;
}

/** Reset the probe — for tests, and for anything that knows the environment
 *  changed under us. */
export function forgetSystemTex(): void {
  probe = undefined;
  latexmkLaunch = pathLaunch();
}

/**
 * What the reader should do about the local TeX, given what we found when we
 * looked for one. Used when the bundled engine could not compile at all — the
 * moment where "install a TeX distribution" is either the right answer or
 * exactly the wrong one, and the difference is invisible from the log.
 */
export function systemTexAdvice(
  p?: SystemTexProbe,
  ctx: { packages?: string[]; fallback?: SystemFallback } = {},
): string {
  // Two things this got wrong on its first outing against a real paper, both the
  // same mistake — asserting something that had not been measured:
  //
  //   1. Asked for `backend: "wasm"` it said "your local TeX ran and did not get
  //      through this either" about a TeX that was never invoked.
  //   2. Under `auto` it blamed the local TeX's failure on THIS missing package,
  //      when the local TeX had sailed past it and died on something else
  //      entirely (a figure needing shell-escape).
  //
  // So: only the `fallback` — which exists solely when the local TeX actually
  // ran — may be used to say anything about what the local TeX did, and only the
  // packages IT reported missing may be handed to tlmgr.
  const bundle = (n: string) => CTAN_BUNDLE[n] ?? n;
  if (p?.usable) {
    if (!ctx.fallback) {
      return 'You have a working local TeX, and it was not used because this run asked for the bundled engine. Re-run without `backend: "wasm"` — the default picks your local TeX up automatically, and it is likely to have this package.';
    }
    const alsoMissingThere = [...new Set([...ctx.fallback.missingPackages, ...ctx.fallback.missingClasses])]
      .filter((m) => (ctx.packages ?? []).includes(m));
    if (alsoMissingThere.length) {
      return `Your local TeX ran and is missing ${alsoMissingThere.length > 1 ? 'these too' : 'this too'}. Add ${alsoMissingThere.length > 1 ? 'them' : 'it'} with \`tlmgr install ${[...new Set(alsoMissingThere.map(bundle))].join(' ')}\` (prefix with sudo on a system-wide TeX Live).`;
    }
    // The local TeX got past this package and failed on something else. Saying
    // "install it there" would send the reader to fix a problem they do not have.
    // Three sources for "why", in descending order of how much they tell the
    // reader — and a real one for the case where the local run reported nothing
    // at all, which does happen: latexmk on a second run over an existing build
    // directory can fail with a log carrying none of the signatures we classify,
    // leaving every field of the fallback empty. An earlier version trailed off
    // mid-sentence there.
    const why = ctx.fallback.errors[0]
      ? `:\n\n  ${ctx.fallback.errors[0]}`
      : ctx.fallback.blockedTools?.length
        ? `: the document needs ${ctx.fallback.blockedTools.join(', ')}, which LaTeX will not run without shell-escape. Re-run with \`shellEscape: true\` if you trust this source.`
        : ', which it did not report in a form we could read. Re-run with `backend: "system"` to see its output directly.';
    return `Your local TeX ran and got further — it did not report this package missing, so it has it. It failed for a different reason${why}\n\nFixing that is the shorter path to a PDF than getting the bundled engine through this package.`;
  }
  if (p?.reason === 'broken') {
    const perl = /script engine|perl/i.test(p.detail ?? '');
    return [
      'A local TeX would have this package, and MagicTeX uses one automatically when it can.',
      '`latexmk` is on PATH here but could not run:',
      ...(p.detail ? ['', p.detail.split('\n').map((l) => `  ${l}`).join('\n')] : []),
      '',
      ...(perl
        ? ['latexmk is a Perl script and MiKTeX ships no Perl interpreter. Install Strawberry',
           'Perl (https://strawberryperl.com/), or TeX Live for Windows (https://tug.org/texlive/),',
           'which bundles one.']
        : ['Fix that and MagicTeX will pick it up without any further configuration.']),
    ].join('\n');
  }
  return `A local TeX install would have this package, and MagicTeX picks one up automatically once there is one.\n\n${INSTALL_TEX_HELP}`;
}

/**
 * What to say when `backend: "system"` was asked for and cannot be honoured.
 *
 * The two cases need opposite things from the reader and used to get the same
 * sentence. "Found but cannot execute" is the one that reads as a lie, because
 * `latexmk` is right there on PATH.
 */
export function systemTexUnavailableMessage(p: SystemTexProbe): string {
  if (p.reason !== 'broken') {
    return `backend "system" was requested, but no local TeX was found — looked for \`latexmk\` on PATH.\n\n${INSTALL_TEX_HELP}`;
  }
  const perl = /script engine|perl/i.test(p.detail ?? '');
  return [
    'backend "system" was requested. `latexmk` is on PATH but could not run:',
    ...(p.detail ? ['', p.detail.split('\n').map((l) => `  ${l}`).join('\n')] : []),
    '',
    ...(perl
      ? [
          'latexmk is a Perl script, and MiKTeX does not ship a Perl interpreter —',
          'so its latexmk.exe can never execute on its own. Install Strawberry Perl',
          '(https://strawberryperl.com/), or use TeX Live for Windows',
          '(https://tug.org/texlive/), which bundles one.',
          '',
        ]
      : []),
    'Or use backend "wasm", which needs nothing installed.',
  ].join('\n');
}

const ENGINE_FLAG: Record<Engine, string> = {
  xelatex: '-xelatex', lualatex: '-lualatex', pdflatex: '-pdf',
};

/** Public for a small contract test: dropping -synctex=1 silently degrades the
 * viewer back to phrase matching while every ordinary compile still passes. */
export function systemLatexmkArgs(
  outdir: string,
  mainRelPath: string,
  engine: Engine,
  shellEscape = false,
  force = false,
): string[] {
  return [
    ENGINE_FLAG[engine] ?? '-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error',
    ...(force ? ['-g'] : []),
    ...(shellEscape ? ['-shell-escape'] : []),
    `-outdir=${outdir}`, mainRelPath,
  ];
}

/** latexmk can cache a failed rule, then answer the next corrected run with
 * "Nothing to do" while returning the old nonzero status. A forced dependency
 * rebuild is appropriate only for that exact stale-error combination. */
export function isStaleLatexmkFailure(log: string): boolean {
  return /Nothing to do/i.test(log) && /error in previous invocation/i.test(log);
}

/**
 * Stop waiting when latexmk has gone quiet, not when the clock says so.
 *
 * The old limit was a flat 180 s of wall time, which a real paper exceeds
 * without anything being wrong: a multi-pass IEEE build (xelatex → bibtex →
 * xelatex, reloading a large package set each pass, converting figures through
 * Inkscape) simply takes longer than that. Two readers chased phantom LaTeX
 * errors before either noticed the clock was pinned at exactly three minutes.
 *
 * A wedged compile and a slow one are indistinguishable by elapsed time, but not
 * by output: latexmk narrates continuously, and a run blocked on a subprocess
 * that will never return says nothing at all. So the idle timer is the real
 * signal, and the cap is only a backstop against a process that chatters forever.
 */
const IDLE_LIMIT_MS = 120_000;
const HARD_LIMIT_MS = 20 * 60_000;

/**
 * Kill the process and everything it started.
 *
 * `execFile`'s own `timeout` kills only the child it spawned. latexmk is a Perl
 * script that spawns xelatex, which spawns Inkscape — so a timeout left the
 * whole tree running. Measured with a deliberate three-level tree and a 3 s
 * timeout: `killed=true signal=SIGTERM`, and the grandchild still ALIVE. On this
 * machine two failed compiles of one paper left seven live processes holding
 * handles on the build directory, which then slowed the next attempt into
 * timing out as well.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // No process groups; taskkill /T walks the child tree for us.
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
    return;
  }
  // Negative pid = the process group, which `detached: true` gave this child.
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

/** Compile `mainRelPath` (relative to `root`) with local latexmk; artifacts go
 *  under .latex-preview/build so the project tree stays clean. */
export async function compileWithSystemTex(root: string, mainRelPath: string, engine: Engine, shellEscape = false): Promise<CompileOutput> {
  const started = Date.now();
  const outdir = join(root, '.latex-preview', 'build');
  await mkdir(outdir, { recursive: true });
  const stem = basename(mainRelPath).replace(/\.tex$/i, '');
  const pdfPath = join(outdir, stem + '.pdf');
  const syncPath = join(outdir, stem + '.synctex.gz');
  // Adding -synctex=1 to an existing latexmk build does not itself invalidate
  // the target: latexmk says "Nothing to do" and leaves no map. Force exactly
  // that one upgrade build; subsequent compiles remain incremental.
  const [hadPdf, hadSync] = await Promise.all([
    access(pdfPath).then(() => true, () => false),
    access(syncPath).then(() => true, () => false),
  ]);
  // -shell-escape lets the document execute arbitrary shell commands, so it is
  // opt-in per call rather than a default. Packages like svg and minted cannot
  // work without it, and the user is the only one who can say whether this
  // particular source is trusted.
  const args = systemLatexmkArgs(outdir, mainRelPath, engine, shellEscape, hadPdf && !hadSync);

  let { code, out, stopped } = await runLatexmk(root, args);
  if (!stopped && code !== 0 && isStaleLatexmkFailure(out)) {
    const retryArgs = systemLatexmkArgs(outdir, mainRelPath, engine, shellEscape, true);
    const retry = await runLatexmk(root, retryArgs);
    code = retry.code;
    stopped = retry.stopped;
    out += `\n\n[MagicTeX: latexmk retained an earlier failed rule; forced one clean dependency rebuild.]\n${retry.out}`;
  }

  if (stopped) {
    const waited = Math.round((Date.now() - started) / 1000);
    const why = stopped === 'idle'
      ? `your local TeX produced no output for ${IDLE_LIMIT_MS / 1000}s and was stopped after ${waited}s`
      : `your local TeX was still running after ${waited}s and was stopped`;
    return {
      success: false, exitCode: code ?? 1, pdf: undefined, pdfLen: 0, log: out, ms: Date.now() - started,
      // Named as a stop, not a failure: the document may be perfectly fine. The
      // usual cause is a subprocess waiting on something — a package installer
      // prompt, or a shell-escape tool the TeX distribution refuses to run.
      error: `The compile was stopped, not finished — ${why}. The document may be fine: a local TeX usually wedges on a subprocess waiting for something (a package-manager prompt, or a shell-escape helper it will not run). Nothing here says your source has an error.`,
    };
  }

  if (code === 0) {
    try {
      const pdf = new Uint8Array(await readFile(pdfPath));
      // A PDF remains useful even if an unusual TeX installation did not emit
      // SyncTeX. The viewer will transparently retain its text-match fallback.
      const syncTex = await readFile(syncPath).then((b) => new Uint8Array(b), () => undefined);
      return { success: true, exitCode: 0, pdf, syncTex, pdfLen: pdf.length, log: out, ms: Date.now() - started };
    } catch {
      return { success: false, exitCode: 0, pdf: undefined, pdfLen: 0, log: out, ms: Date.now() - started, error: 'latexmk reported success but wrote no PDF' };
    }
  }
  return { success: false, exitCode: code ?? 1, pdf: undefined, pdfLen: 0, log: out, ms: Date.now() - started, error: 'system latexmk compile failed' };
}

/** Run latexmk, collecting output and watching for silence. Resolves rather than
 *  throws: a non-zero exit is an ordinary outcome here, not an exception. */
function runLatexmk(cwd: string, args: string[]): Promise<{ code: number | null; out: string; stopped?: 'idle' | 'cap' }> {
  return new Promise((resolve) => {
    const launch = latexmkLaunch;
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
      cwd,
      windowsHide: true,
      env: launch.env,
      // POSIX: its own process group, so killTree can take the group down.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let stopped: 'idle' | 'cap' | undefined;
    const CAP = 32 * 1024 * 1024;
    const absorb = (b: Buffer) => {
      if (out.length < CAP) out += b.toString();
      bump();
    };

    let idle: NodeJS.Timeout;
    const stop = (why: 'idle' | 'cap') => {
      stopped = why;
      if (child.pid) killTree(child.pid);
    };
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => stop('idle'), IDLE_LIMIT_MS);
    };
    const cap = setTimeout(() => stop('cap'), HARD_LIMIT_MS);

    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);
    bump();

    child.on('error', (e) => {
      clearTimeout(idle); clearTimeout(cap);
      resolve({ code: 1, out: out + String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(idle); clearTimeout(cap);
      resolve({ code, out, stopped });
    });
  });
}
