import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSystemTex, forgetSystemTex, isStaleLatexmkFailure, systemTexUnavailableMessage, systemTexAdvice } from '../src/engine/systemTex.js';

// "No local TeX" and "a local TeX that cannot run" are different problems with
// opposite answers, and they used to produce the same sentence. A user installed
// MiKTeX, MagicTeX kept saying no local TeX was found, and an agent eventually
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
  // install — including one the user made *because* MagicTeX told them a package
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
