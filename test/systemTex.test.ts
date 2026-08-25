import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSystemTex, forgetSystemTex, isStaleLatexmkFailure, posixLatexmkCandidates, sweepStaleBuildDirs, systemBuildDir, systemLatexmkArgs, systemTexResult, systemTexUnavailableMessage, systemTexAdvice, MIKTEX_ASK_NOTE, isPosixEmulationPerl, orderLaunchCandidates, miktexInstallerMode, disableInstallerArg } from '../src/engine/systemTex.js';

// "No local TeX" and "a local TeX that cannot run" are different problems with
// opposite answers, and they used to produce the same sentence. A user installed
// MiKTeX, TeXChronicle kept saying no local TeX was found, and an agent eventually
// gave up on the tool and invoked the compiler itself.

// MiKTeX's actual output, kept verbatim — this is the string the fix has to
// recognise, and paraphrasing it would let a change in our regex pass a test
// that the real message would fail.
const MIKTEX_NO_PERL = [
  'Sorry, but latexmk.exe did not succeed for the following reason:',
  "  MiKTeX could not find the script engine 'perl' which is required to execute 'latexmk'.",
  'Remedy:',
  "  Make sure 'perl' is installed on your system.",
].join('\n');

test('a latexmk that cannot run is never reported as "no local TeX was found"', () => {
  const msg = systemTexUnavailableMessage({ usable: false, reason: 'broken', detail: MIKTEX_NO_PERL });
  assert.doesNotMatch(msg, /no local TeX was found/,
    'reported a TeX that is on PATH as absent — the sentence that sent a user to reinstall what they had');
  assert.match(msg, /on PATH but could not run/);
  assert.match(msg, /script engine 'perl'/, 'the reason must survive; it is the only actionable line available');
});

test('and it names Perl, because nothing else in the message explains it', () => {
  const msg = systemTexUnavailableMessage({ usable: false, reason: 'broken', detail: MIKTEX_NO_PERL });
  assert.match(msg, /strawberryperl\.com/, 'no way forward for someone who does not know latexmk is Perl');
  assert.match(msg, /backend "wasm"/, 'the zero-install path must stay visible');
});

test('a genuinely absent latexmk still gets the install help', () => {
  const msg = systemTexUnavailableMessage({ usable: false, reason: 'absent' });
  assert.match(msg, /no local TeX was found/);
  assert.match(msg, /tug\.org/, 'the distribution list is the point of this branch');
  // This used to assert Perl was never mentioned here, on the grounds that it is
  // irrelevant to someone with nothing installed. That stopped being true when
  // the install help started naming MiKTeX: telling a Windows reader *before*
  // they install that MiKTeX needs Perl alongside it is the whole point, and it
  // is the trap this project walked into.
  //
  // What must still not happen is diagnosing a broken install for someone who
  // has none — those are the two cases this function exists to separate.
  assert.doesNotMatch(msg, /on PATH but could not run/,
    'told someone with no TeX at all that their TeX cannot run');
  assert.doesNotMatch(msg, /could not find the script engine/,
    'reported a MiKTeX failure to someone who has not installed MiKTeX');
});

test('advice on a failed compile depends on what is actually on the machine', () => {
  // Same failed compile, different machines, different right answers. Before
  // this the reader got a raw log line and nothing else.
  const absent = systemTexAdvice({ usable: false, reason: 'absent' });
  assert.match(absent, /tug\.org/, 'tell someone with no TeX what to install');

  const broken = systemTexAdvice({ usable: false, reason: 'broken', detail: MIKTEX_NO_PERL });
  assert.match(broken, /strawberryperl\.com/);
  assert.doesNotMatch(broken, /tug\.org\/texlive\/\s*$/,
    'telling someone who already has MiKTeX to go install a distribution is the loop being closed');
});

// The next three exist because the first version of this advice asserted two
// things it had not measured, and both were caught by running it against a real
// paper rather than by reading it. A message that sounds right and is false is
// worse than no message: it sends the reader off to fix something they do not
// have.

test('a working local TeX that was never invoked is not described as having failed', () => {
  // `backend: "wasm"` was forced, so nothing ran locally. The old text said
  // "your local TeX ran and did not get through this either".
  const msg = systemTexAdvice({ usable: true }, { packages: ['newtxmath'] });
  assert.doesNotMatch(msg, /ran and/, 'claimed a run that never happened');
  assert.match(msg, /backend: "wasm"/, 'the actionable thing is to stop forcing the bundled engine');
});

test('a local TeX that ran is only blamed for what it actually reported', () => {
  // It sailed past newtxmath and died on a figure needing shell-escape. The old
  // text said the package was "not installed there" and offered a tlmgr command
  // for a package the local TeX already had.
  const msg = systemTexAdvice(
    { usable: true },
    { packages: ['newtxmath'], fallback: { errors: [], missingPackages: [], missingClasses: [], blockedTools: ['Inkscape'] } },
  );
  assert.doesNotMatch(msg, /tlmgr install newtxmath/, 'told the reader to install a package their TeX already has');
  assert.match(msg, /it has it/);
  assert.match(msg, /Inkscape/, 'the reason it really failed is the useful part');
  assert.doesNotMatch(msg, /different reason\s*$/, 'the sentence trailed off when no reason was carried');
});

test('and when it reported nothing readable, the sentence still finishes', () => {
  // latexmk over an existing build directory can fail with a log carrying none
  // of the signatures we classify — every field of the fallback empty. Measured
  // on a real project, not hypothetical.
  const msg = systemTexAdvice(
    { usable: true },
    { packages: ['newtxmath'], fallback: { errors: [], missingPackages: [], missingClasses: [], blockedTools: [] } },
  );
  assert.doesNotMatch(msg, /different reason\s*\n/, 'trailed off mid-sentence');
  assert.match(msg, /backend: "system"/, 'give them a way to see the output we could not read');
});

test('a package the local TeX is also missing does get a tlmgr command, with the real name', () => {
  const msg = systemTexAdvice(
    { usable: true },
    { packages: ['newtxmath'], fallback: { errors: [], missingPackages: ['newtxmath'], missingClasses: [], blockedTools: [] } },
  );
  assert.match(msg, /tlmgr install newtxmath/, 'a placeholder like `<package>` is a command nobody can paste');
});

test('only latexmk stale-error output triggers a forced rebuild', () => {
  assert.equal(isStaleLatexmkFailure([
    "Latexmk: Nothing to do for 'paper.tex'.",
    'Collected error summary:',
    '  pdflatex: gave an error in previous invocation of latexmk.',
  ].join('\n')), true);
  assert.equal(isStaleLatexmkFailure("Latexmk: Nothing to do for 'paper.tex'. All targets are up-to-date."), false);
  assert.equal(isStaleLatexmkFailure('! LaTeX Error: Undefined control sequence.'), false);
});

test('latexmk continues through recoverable MiKTeX first-pass failures', () => {
  const args = systemLatexmkArgs('build', 'paper.tex', 'pdflatex');
  assert.ok(args.includes('-f'), 'latexmk would stop before bibliography and reference reruns');
});

test('system TeX artifacts are isolated per TeXChronicle process', () => {
  const root = join(tmpdir(), 'paper');
  assert.notEqual(systemBuildDir(root, 1001), systemBuildDir(root, 1002));
  assert.match(systemBuildDir(root, 1001).replace(/\\/g, '/'), /\.latex-preview\/build\/1001-[0-9a-f]{8}$/);
});

test('latexmk compiles from the main file\'s own directory', () => {
  // `paper/main.tex` with `\input{sections/body}` means `paper/sections`. Run
  // from the project root instead, the document died on "File
  // `sections/body.tex' not found" — while the WASM backend compiled it fine.
  const args = systemLatexmkArgs('/tmp/build', 'paper/main.tex', 'pdflatex');
  assert.ok(args.includes('-cd'), 'a main file in a subdirectory could not resolve its own relative inputs');
  assert.ok(args.some((a) => a.startsWith('-outdir=')), 'the build directory has to stay absolute, or -cd moves it');
});

// ── a PDF that exists is a PDF, whatever latexmk exited with ─────────────────

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

test('an ordinary LaTeX error still hands back the PDF LaTeX wrote', () => {
  // latexmk exits 12 on any error even under -f. Reading the PDF only on exit 0
  // meant one typo produced pdfLen=0 — so a paper that typeset every page came
  // back as "your local TeX produced nothing", and `auto` switched to the
  // bundled engine behind the user's back.
  const r = systemTexResult(12, '! Undefined control sequence.', 40, { pdf: PDF });
  assert.equal(r.pdfLen, 4, 'the pages were there and were thrown away');
  assert.equal(r.success, false, 'the exit code still decides success');
  assert.match(r.error ?? '', /wrote a PDF/, 'the reader has to be told this is an ordinary source error');
});

test('a clean run is a clean run', () => {
  const r = systemTexResult(0, 'Output written on main.pdf', 40, { pdf: PDF, syncTex: PDF });
  assert.equal(r.success, true);
  assert.equal(r.error, undefined, 'nothing to explain');
  assert.ok(r.syncTex, 'the source map has to survive');
});

test('no PDF at all is reported differently depending on what latexmk claimed', () => {
  assert.match(systemTexResult(0, '', 1).error ?? '', /reported success but wrote no PDF/);
  assert.match(systemTexResult(12, '', 1).error ?? '', /system latexmk compile failed/);
  assert.equal(systemTexResult(12, '', 1).pdfLen, 0);
});

// ── build directories left by processes that are gone ───────────────────────

test('build directories of dead processes are swept, and the live one is not', async () => {
  // Each process gets its own so two cannot race on the same aux files, and a
  // graceful exit removes it. Nothing removed them after a crash or a taskkill,
  // so a project accumulated one abandoned full PDF per hard stop, forever.
  const root = mkdtempSync(join(tmpdir(), 'texchronicle-sweep-'));
  try {
    const build = join(root, '.latex-preview', 'build');
    const dead = join(build, '999999-deadbeef');
    const mine = join(build, `${process.pid}-cafebabe`);
    const notOurs = join(build, 'scratch');
    for (const d of [dead, mine, notOurs]) mkdirSync(d, { recursive: true });
    writeFileSync(join(dead, 'main.pdf'), 'x');

    await sweepStaleBuildDirs(root, mine);

    assert.equal(existsSync(dead), false, 'a directory whose PID is gone cannot be in use by anyone');
    assert.equal(existsSync(mine), true, 'the live build directory must never be touched');
    assert.equal(existsSync(notOurs), true, 'anything not named <pid>-<session> is not ours to delete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Unix discovery ──────────────────────────────────────────────────────────
//
// UNTESTED ON A REAL TARGET: this machine is Windows, so the candidate list is
// exercised against injected filesystem stubs rather than a MacTeX install.

test('a GUI-launched macOS client finds MacTeX outside its inherited PATH', async () => {
  // An app-launched MCP client gets /usr/bin:/bin and nothing else — no login
  // shell has run, so /Library/TeX/texbin is never on it and a full MacTeX is
  // reported as "no local TeX was found".
  const present = new Set(['/Library/TeX/texbin/latexmk', '/opt/homebrew/bin/latexmk']);
  const found = await posixLatexmkCandidates({
    exists: async (p) => present.has(p),
    listDir: async () => [],
  });
  assert.deepEqual(found, ['/Library/TeX/texbin/latexmk', '/opt/homebrew/bin/latexmk']);
  assert.equal(found[0], '/Library/TeX/texbin/latexmk', 'the symlink farm is stable across TeX Live years, so it goes first');
});

test('a versioned TeX Live tree is discovered without guessing the year or the architecture', async () => {
  const tree: Record<string, string[]> = {
    '/usr/local/texlive': ['2023', '2025', 'texmf-local'],
    '/usr/local/texlive/2025/bin': ['universal-darwin'],
    '/usr/local/texlive/2023/bin': ['x86_64-darwin'],
    '/usr/local/texlive/texmf-local/bin': [],
  };
  const found = await posixLatexmkCandidates({
    exists: async (p) => p.endsWith('/latexmk') && p.startsWith('/usr/local/texlive'),
    listDir: async (p) => tree[p] ?? [],
  });
  assert.equal(found[0], '/usr/local/texlive/2025/bin/universal-darwin/latexmk', 'the newest install wins');
  assert.ok(found.includes('/usr/local/texlive/2023/bin/x86_64-darwin/latexmk'));
});

test('finding nothing is not an error', async () => {
  assert.deepEqual(await posixLatexmkCandidates({ exists: async () => false, listDir: async () => [] }), []);
});

// ── the staleness fix ───────────────────────────────────────────────────────

/**
 * A fake latexmk that exits non-zero — enough to prove the probe ran again and
 * saw something new, without needing a working TeX on the test machine.
 *
 * Windows needs a real `.exe`: `execFile` without a shell does not resolve
 * `.cmd`/`.bat` through PATHEXT at all, and a stub written as `latexmk.cmd`
 * comes back ENOENT — indistinguishable from no stub, which would have made
 * this test pass for the wrong reason. Any small system binary does; `whoami`
 * rejects `-version` and exits 1. Real TeX distributions ship `latexmk.exe`, so
 * the executable-resolution path being exercised is the real one.
 */
function fakeLatexmk(dir: string): void {
  if (process.platform === 'win32') {
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), join(dir, 'latexmk.exe'));
    return;
  }
  const p = join(dir, 'latexmk');
  writeFileSync(p, '#!/bin/sh\necho "pretend latexmk" >&2\nexit 3\n');
  chmodSync(p, 0o755);
}

const WINDOWS_DISCOVERY_ENV = ['LOCALAPPDATA', 'SystemDrive', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'ProgramData'] as const;

function isolateWindowsDiscovery(root: string): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of WINDOWS_DISCOVERY_ENV) previous.set(key, process.env[key]);
  process.env.LOCALAPPDATA = join(root, 'local');
  process.env.SystemDrive = join(root, 'drive');
  process.env.ProgramFiles = join(root, 'program-files');
  process.env.ProgramW6432 = join(root, 'program-w6432');
  process.env['ProgramFiles(x86)'] = join(root, 'program-files-x86');
  process.env.ProgramData = join(root, 'program-data');
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

test('Windows discovers installed MiKTeX and Strawberry Perl outside stale PATH', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'commontex-'));
  const emptyPath = join(root, 'empty-path');
  const restoreDiscovery = isolateWindowsDiscovery(root);
  const previousPath = process.env.PATH;
  try {
    mkdirSync(emptyPath, { recursive: true });
    const scriptDir = join(process.env.LOCALAPPDATA!, 'Programs', 'MiKTeX', 'scripts', 'latexmk');
    const miktexBin = join(process.env.LOCALAPPDATA!, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64');
    const perlDir = join(process.env.SystemDrive!, 'Strawberry', 'perl', 'bin');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(miktexBin, { recursive: true });
    mkdirSync(perlDir, { recursive: true });
    // Node is a convenient real Windows executable that accepts a script path;
    // the file extension does not matter, so it stands in for Perl faithfully.
    writeFileSync(join(scriptDir, 'latexmk.pl'), 'process.exit(0);');
    copyFileSync(process.execPath, join(perlDir, 'perl.exe'));

    process.env.PATH = emptyPath;
    forgetSystemTex();
    const found = await probeSystemTex();
    assert.equal(found.usable, true, 'the common installs were ignored because the process PATH was stale');
  } finally {
    forgetSystemTex();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    restoreDiscovery();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a TeX that appears after the first check is not ignored for the rest of the session', async () => {
  // The memo used to be permanent, so a `null` recorded at startup outlived any
  // install — including one the user made *because* TeXChronicle told them a package
  // was missing. This is a long-lived stdio process; that window is the whole
  // working session.
  const dir = mkdtempSync(join(tmpdir(), 'faketex-'));
  const prevPath = process.env.PATH;
  const restoreDiscovery = isolateWindowsDiscovery(dir);
  try {
    forgetSystemTex();
    process.env.PATH = dir; // nothing here yet
    const before = await probeSystemTex();
    assert.equal(before.usable, false);
    assert.equal(before.reason, 'absent', 'an empty PATH must read as absent, not broken');

    fakeLatexmk(dir); // the user installs a TeX, mid-session
    const after = await probeSystemTex();
    assert.equal(after.reason, 'broken',
      'the probe never looked again — a TeX installed after startup stayed invisible');
    // The stub's own output only exists on the POSIX arm — `whoami` says almost
    // nothing. The transition above is the assertion that matters; this pins
    // that whatever the tool did say survives the catch.
    if (process.platform !== 'win32') {
      assert.match(after.detail ?? '', /pretend latexmk/, 'and its output must reach the caller');
    } else {
      assert.ok((after.detail ?? '').length > 0, 'something about the failure must reach the caller');
    }
  } finally {
    forgetSystemTex();
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    restoreDiscovery();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── MSYS/Cygwin perl shadowing Strawberry Perl (Windows) ─────────────────────
//
// Measured on this machine with one project holding `refs.bib` and
// `\bibliography{refs}`:
//
//   from PowerShell   PATH perl = C:\Strawberry\perl\bin\perl.exe ($^O MSWin32)
//                     -> "Cite [1].  References  [1] Donald E. Knuth. ..."
//   from Git Bash     PATH perl = /usr/bin/perl                   ($^O cygwin)
//                     -> latexmk sets BIBINPUTS=/tmp/claude/... and bibtex says
//                        "I couldn't open database file refs.bib"
//                     -> "Cite [?].  References" and nothing under the heading
//
// The compile succeeds either way. Only the bibliography is missing, so this
// reaches the reader as their own citation keys being wrong.

test('an MSYS/Cygwin perl on PATH is recognised, and a real Windows perl is not', () => {
  assert.equal(isPosixEmulationPerl('msys'), true);
  assert.equal(isPosixEmulationPerl('cygwin'), true);
  assert.equal(isPosixEmulationPerl('cygwin\n'), true, 'perl prints without a newline, but do not depend on it');
  assert.equal(isPosixEmulationPerl('MSWin32'), false, "Strawberry Perl and TeX Live's own perl both say this");
  assert.equal(isPosixEmulationPerl('darwin'), false);
  assert.equal(isPosixEmulationPerl(undefined), false, 'no perl at all is not a reason to reorder anything');
});

test('the PATH latexmk normally goes first', () => {
  assert.deepEqual(orderLaunchCandidates('path', ['strawberry', 'miktex'], false),
    ['path', 'strawberry', 'miktex'],
    "it is the user's own choice and the cheapest to launch");
});

test("but it is demoted when PATH's perl is the broken one", () => {
  assert.deepEqual(orderLaunchCandidates('path', ['strawberry', 'miktex'], true),
    ['strawberry', 'miktex', 'path'],
    "the explicit launches put Strawberry Perl ahead of MSYS on the child's PATH");
});

test('and demotion never leaves us with nothing to run', () => {
  // No Strawberry Perl installed: the PATH launch is all there is, broken perl
  // or not, and dropping it would report "no local TeX" on a machine with one.
  assert.deepEqual(orderLaunchCandidates('path', [], true), ['path']);
});

// ── MiKTeX "ask before installing" ───────────────────────────────────────────
//
// `[MPM]AutoInstall` is a MiKTeX TriState (False=0, True=1, Undetermined=2 —
// from MiKTeX's own Configuration/TriState.h), and Undetermined is the "ask me
// first" the Console sets on a fresh install. The dialog is a GUI window; we
// spawn the engine with windowsHide, so nobody answers it and the compile sits
// there until the 120 s idle stop, reported as a wedged toolchain.

test('only a value that really says "ask" changes how the engine is invoked', () => {
  assert.equal(miktexInstallerMode('2'), 'ask');
  assert.equal(miktexInstallerMode('1'), 'always');
  assert.equal(miktexInstallerMode('0'), 'never');
  // A probe we could not read must leave compiles behaving exactly as before.
  assert.equal(miktexInstallerMode(''), 'unknown');
  assert.equal(miktexInstallerMode(undefined), 'unknown');
  assert.equal(miktexInstallerMode('initexmf: unknown configuration value'), 'unknown');
});

test("initexmf's warning lines do not get read as the answer", () => {
  // This machine prints "security risk: running with elevated privileges" ahead
  // of the value, and not every build sends that to stderr.
  assert.equal(miktexInstallerMode('initexmf: security risk: running with elevated privileges\n2\n'), 'ask');
  assert.equal(miktexInstallerMode('initexmf: security risk: running with elevated privileges\n1\n'), 'always',
    "this machine's actual setting — it must not be read as ask and start disabling the installer");
});

test('the installer flag names the option latexmk actually has for each engine', () => {
  // `-xelatex` selects XeLaTeX; the *command* for it is set with `-pdfxelatex=`.
  // Confirmed against latexmk 4.88 -help. A wrong option name makes latexmk
  // reject the whole invocation, so every compile would fail, not just this one.
  assert.equal(disableInstallerArg('pdflatex'), '-pdflatex=pdflatex --disable-installer %O %S');
  assert.equal(disableInstallerArg('xelatex'), '-pdfxelatex=xelatex --disable-installer %O %S');
  assert.equal(disableInstallerArg('lualatex'), '-pdflualatex=lualatex --disable-installer %O %S');
  for (const engine of ['pdflatex', 'xelatex', 'lualatex'] as const) {
    // latexmk substitutes the options it wants passed through and the source
    // file into these; dropping either compiles the wrong thing silently.
    assert.match(disableInstallerArg(engine), /%O %S$/);
  }
});

test('and it is absent unless MiKTeX was found to be asking', () => {
  const ordinary = systemLatexmkArgs('/tmp/build', 'paper.tex', 'xelatex', false, false, false);
  const asking = systemLatexmkArgs('/tmp/build', 'paper.tex', 'xelatex', false, false, true);
  assert.ok(!ordinary.some((a) => a.includes('--disable-installer')),
    'a TeX Live machine has no installer to disable, and would be handed an argument it cannot use');
  assert.ok(asking.includes('-pdfxelatex=xelatex --disable-installer %O %S'));
  assert.ok(asking.includes('-xelatex'), 'the engine is still selected the same way');
});

test('the note names the two things that actually clear the dialog', () => {
  // Prescribed wording, pinned: this is the only place the reader is told that
  // the packages are one command away rather than unavailable, and a compile
  // that has just been stopped is the worst moment to be vague.
  assert.match(MIKTEX_ASK_NOTE, /mpm --install=<pkg>/, 'the one-off fix');
  assert.match(MIKTEX_ASK_NOTE, /Always install missing packages/, 'the permanent fix');
  assert.match(MIKTEX_ASK_NOTE, /cannot answer that dialog/, 'why it did not just work');
});
