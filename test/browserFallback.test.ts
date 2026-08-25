// "It should be totally self contained": nobody should ever be told to run
// `npx playwright install` by hand. Three things make that true — a postinstall
// download, a self-heal on first use, and borrowing an installed Chrome or Edge
// when neither worked — and all three are decisions made before any browser is
// launched. Those decisions are what this file pins down, so the policy can be
// read off a test instead of a 150 MB download and a machine with no Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { browserPlan, isMissingBrowser } from '../src/engine/browserHost.js';
import {
  SKIP_VARS,
  browsersRoot,
  downloadSkippedBy,
  headlessShellDir,
  headlessShellPresent,
  installCommand,
} from '../bin/ensureBrowser.mjs';

/** The plan as a list of short tags, which is the only part worth asserting. */
const tags = (env: NodeJS.ProcessEnv, opts?: { canInstall?: boolean }) =>
  browserPlan(env, opts).map((c) =>
    c.kind === 'channel' ? `channel:${c.channel}`
      : c.kind === 'env' ? `env:${c.channel ?? c.executablePath}`
        : c.kind);

test('with nothing configured: the bundled shell, then fetching it, then a browser you already have', () => {
  assert.deepEqual(tags({}), ['bundled', 'install', 'channel:chrome', 'channel:msedge']);
});

test('TEXCHRONICLE_BROWSER goes first, and the rest stays as a safety net', () => {
  assert.deepEqual(tags({ TEXCHRONICLE_BROWSER: 'msedge' }),
    ['env:msedge', 'bundled', 'install', 'channel:chrome', 'channel:msedge']);
});

// A channel is a name Playwright knows; anything else can only be a file. Getting
// this backwards would hand `executablePath: 'chrome'` to Playwright, which fails
// with a confusing "Executable doesn't exist at chrome".
test('a known channel name is a channel; anything else is a path to an executable', () => {
  assert.deepEqual(tags({ TEXCHRONICLE_BROWSER: 'chrome' })[0], 'env:chrome');
  assert.deepEqual(tags({ TEXCHRONICLE_BROWSER: 'chromium' })[0], 'env:chromium');
  assert.deepEqual(tags({ TEXCHRONICLE_BROWSER: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })[0],
    'env:C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.deepEqual(tags({ TEXCHRONICLE_BROWSER: '/usr/bin/brave' })[0], 'env:/usr/bin/brave');
});

// Environment variables arrive with whatever a shell, a .env file or an MCP
// client config left on them.
test('the channel name survives stray case and whitespace', () => {
  assert.equal(tags({ TEXCHRONICLE_BROWSER: '  MsEdge \n' })[0], 'env:msedge');
});

test('an empty TEXCHRONICLE_BROWSER is not a browser', () => {
  assert.deepEqual(tags({ TEXCHRONICLE_BROWSER: '   ' }), ['bundled', 'install', 'channel:chrome', 'channel:msedge']);
});

// Someone who forbids the download still gets the fallbacks — that is the whole
// point of forbidding it on a machine that cannot reach the CDN.
test('forbidding the download removes only the download', () => {
  assert.deepEqual(tags({}, { canInstall: false }), ['bundled', 'channel:chrome', 'channel:msedge']);
});

test('both skip variables are honoured, ours and Playwright’s own', () => {
  assert.deepEqual(SKIP_VARS, ['TEXCHRONICLE_SKIP_BROWSER_DOWNLOAD', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']);
  assert.equal(downloadSkippedBy({ TEXCHRONICLE_SKIP_BROWSER_DOWNLOAD: '1' }), 'TEXCHRONICLE_SKIP_BROWSER_DOWNLOAD');
  assert.equal(downloadSkippedBy({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }), 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD');
  assert.equal(downloadSkippedBy({}), null);
});

// Writing `...=0` to turn a flag OFF is the obvious thing to try, and it is how
// Playwright itself reads its own flags. Treating it as "set" would give the
// person the exact opposite of what they asked for.
test('0, false and empty do not count as "skip"', () => {
  for (const value of ['0', 'false', 'FALSE', '']) {
    assert.equal(downloadSkippedBy({ TEXCHRONICLE_SKIP_BROWSER_DOWNLOAD: value }), null, `"${value}" must not skip`);
  }
});

// The composition the launcher actually performs, checked end to end so the two
// halves cannot drift apart.
test('a skip variable in the environment takes the download out of the plan', () => {
  const env = { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  assert.deepEqual(tags(env, { canInstall: !downloadSkippedBy(env) }),
    ['bundled', 'channel:chrome', 'channel:msedge']);
});

// A 150 MB download is far too expensive to spend on a guess: only "there is no
// executable" is worth answering with one. A browser that exists and crashed is
// not fixed by downloading it again.
test('only a missing executable is worth re-downloading a browser for', () => {
  assert.equal(isMissingBrowser(new Error("browserType.launch: Executable doesn't exist at /nowhere")), true);
  assert.equal(isMissingBrowser("EXECUTABLE DOESN'T EXIST at /nowhere"), true);
  assert.equal(isMissingBrowser(new Error('browserType.launch: Target page, context or browser has been closed')), false);
  assert.equal(isMissingBrowser(new Error('Host system is missing dependencies to run browsers')), false);
  assert.equal(isMissingBrowser(new Error('spawn EACCES')), false);
  assert.equal(isMissingBrowser(undefined), false);
});

// npx would reach for the network to fetch something already on disk, and on
// Windows it needs a shell — which is how a path containing a space gets split
// into two arguments (see src/engine/assets.ts, where that really happened).
test('the installer is this node running playwright’s own CLI file — never npx', () => {
  const { command, args } = installCommand();
  assert.equal(command, process.execPath);
  assert.equal(basename(args[0]), 'cli.js');
  assert.ok(existsSync(args[0]), `${args[0]} must be a real file`);
  assert.deepEqual(args.slice(1), ['install', 'chromium', '--only-shell']);
  assert.doesNotMatch([command, ...args].join(' '), /npx/);
});

test('PLAYWRIGHT_BROWSERS_PATH decides where the browser is looked for', () => {
  assert.equal(browsersRoot({ PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers' }), '/opt/browsers');
  // Every platform's default ends in the directory Playwright actually uses; the
  // portable build globs for it by that name.
  assert.equal(basename(browsersRoot({})), 'ms-playwright');
});

// The revision matters. After a Playwright upgrade the previous revision is
// still on disk, and treating that as "already installed" is how a peer ends up
// with a shell their Playwright refuses to drive.
test('the shell is only "present" at the revision this Playwright asks for, and only once its download finished', () => {
  const root = mkdtempSync(join(tmpdir(), 'browsers-'));
  const env = { PLAYWRIGHT_BROWSERS_PATH: root };
  try {
    assert.equal(headlessShellPresent(env), false, 'an empty browsers directory holds no browser');

    const wanted = headlessShellDir(env);
    assert.ok(wanted, 'playwright must declare a headless-shell revision');
    assert.match(basename(wanted), /^chromium_headless_shell-\d+$/);

    // An interrupted download leaves the directory behind, half full.
    mkdirSync(wanted, { recursive: true });
    assert.equal(headlessShellPresent(env), false, 'a half-finished download is not a browser');

    writeFileSync(join(wanted, 'INSTALLATION_COMPLETE'), '');
    assert.equal(headlessShellPresent(env), true);

    // Some other revision is somebody else's browser.
    rmSync(wanted, { recursive: true, force: true });
    const stale = join(root, 'chromium_headless_shell-1');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'INSTALLATION_COMPLETE'), '');
    assert.equal(headlessShellPresent(env), false, 'a browser for another Playwright does not count');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
