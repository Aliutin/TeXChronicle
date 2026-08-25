#!/usr/bin/env node
// Playwright brings no browser with it — 1.62 has no postinstall hook of its own —
// so a plain `npm install texchronicle` used to leave the first render failing on
// a Chromium that was never downloaded, and every peer had to be told to run
// `npx playwright install` by hand. That is exactly the instruction a tool that
// claims to be self-contained must not need, so this package downloads the
// browser itself: once from `postinstall`, and again from src/engine/browserHost.ts
// if a render still finds no browser.
//
// Everything here is plain Node with no dependencies but the ones already on
// disk, because a postinstall script runs in whatever state npm has reached and
// must not assume a build step, a loader, or a supported Node version.
//
// Every line it prints goes to stderr, never stdout. The same functions are
// called from inside the MCP server, where stdout is the JSON-RPC channel and a
// single stray byte corrupts the protocol — one rule for both callers is safer
// than a mode flag someone forgets to pass, and npm shows a postinstall's stderr
// just as readily as its stdout.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFrom = createRequire(import.meta.url);

/** Writes one line where it can never be mistaken for MCP protocol traffic. */
const toStderr = (line) => process.stderr.write(`${line}\n`);

/** The two ways to say "never download a browser on my machine".
 *  The Playwright-branded name is honoured as well as ours because anyone who
 *  already sets it for the rest of their toolchain means it here too. */
export const SKIP_VARS = ['TEXCHRONICLE_SKIP_BROWSER_DOWNLOAD', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];

/**
 * Which variable, if any, forbids downloading a browser — the name, so the
 * caller can say which one it obeyed rather than just going quiet.
 *
 * `0`, `false` and the empty string do NOT count as set: that is how Playwright
 * itself reads its own flags, and a peer who writes `...=0` to turn the skip off
 * would otherwise get the opposite of what they asked for.
 */
export function downloadSkippedBy(env = process.env) {
  for (const name of SKIP_VARS) {
    const value = env[name];
    if (value && value !== '0' && value.toLowerCase() !== 'false') return name;
  }
  return null;
}

/**
 * Where Playwright keeps the browsers it downloads. Mirrors Playwright's own
 * resolution so we can answer "is it already there?" without launching one:
 * `PLAYWRIGHT_BROWSERS_PATH` wins, the special value `0` means "inside the
 * package", and otherwise each platform has its own per-user cache.
 */
export function browsersRoot(env = process.env) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === '0') {
    return join(dirname(requireFrom.resolve('playwright-core/package.json')), '.local-browsers');
  }
  if (configured) return configured;
  const home = homedir();
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'ms-playwright');
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright');
}

/**
 * The directory this exact Playwright expects its headless shell in.
 *
 * The revision is read from playwright-core's own `browsers.json` rather than
 * guessed or globbed: after a Playwright upgrade the old revision is still on
 * disk, and treating that as "already installed" is how a peer ends up with a
 * shell their Playwright refuses to drive. The file is read from beside the
 * package.json because it is not listed in playwright-core's `exports`, so it
 * cannot be reached by subpath.
 */
export function headlessShellDir(env = process.env) {
  const corePkg = requireFrom.resolve('playwright-core/package.json');
  const catalogue = JSON.parse(readFileSync(join(dirname(corePkg), 'browsers.json'), 'utf8'));
  const entry = catalogue.browsers?.find((browser) => browser.name === 'chromium-headless-shell');
  return entry ? join(browsersRoot(env), `chromium_headless_shell-${entry.revision}`) : null;
}

/**
 * True once the shell is really usable. The marker file is what Playwright
 * writes when a download finishes, so an interrupted download — which leaves the
 * directory behind, half full — is correctly reported as missing.
 */
export function headlessShellPresent(env = process.env) {
  try {
    const dir = headlessShellDir(env);
    return Boolean(dir) && existsSync(join(dir, 'INSTALLATION_COMPLETE'));
  } catch {
    return false;
  }
}

/**
 * How to run Playwright's own installer.
 *
 * `playwright/cli.js` is not in the package's `exports`, so it is located
 * through the `bin` entry in its package.json — the package's own statement of
 * where its CLI lives — exactly as src/engine/assets.ts locates the WASM asset
 * downloader. Never `npx`: npx reaches for the network to fetch something that
 * is already on disk, and on Windows it needs a shell, which is how a path
 * containing a space ends up split into two arguments.
 *
 * `--only-shell` fetches the ~150 MB headless shell instead of the full ~450 MB
 * Chromium. Nothing here ever opens a window, so the rest would be dead weight.
 *
 * Exported so a test can check what would be launched without spending 150 MB.
 */
export function installCommand() {
  const pkgPath = requireFrom.resolve('playwright/package.json');
  const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const rel = typeof bin === 'string' ? bin : bin?.playwright;
  if (!rel) throw new Error('playwright declares no CLI entry point');
  return { command: process.execPath, args: [join(dirname(pkgPath), rel), 'install', 'chromium', '--only-shell'] };
}

// One install at a time, and only one per process: the outcome is memoised
// rather than cleared, so two callers racing on the same missing browser share a
// single 150 MB download instead of starting two that fight over the same files.
let running = null;

/**
 * Make sure Playwright's headless shell is on disk, downloading it if not.
 *
 * Never throws and never exits: a browser we could not fetch is a degraded
 * TeXChronicle (the caller can still fall back to an installed Chrome or Edge),
 * while a thrown error out of `postinstall` is a failed `npm install`.
 *
 * Resolves to `{ ok, reason }` where reason is one of `present`, `installed`,
 * `skipped`, `failed` or `unavailable`.
 */
export function ensureHeadlessShell({ note = toStderr } = {}) {
  running ??= install(note);
  return running;
}

async function install(note) {
  if (headlessShellPresent()) return { ok: true, reason: 'present' };

  const skip = downloadSkippedBy();
  if (skip) {
    note(`[texchronicle] ${skip} is set — not downloading a browser.`);
    return { ok: false, reason: 'skipped', detail: skip };
  }

  let launch;
  try {
    launch = installCommand();
  } catch (error) {
    const detail = String(error?.message ?? error);
    note(`[texchronicle] Cannot find Playwright's installer: ${detail}`);
    return { ok: false, reason: 'unavailable', detail };
  }

  note("[texchronicle] Downloading Playwright's Chromium headless shell (~150 MB, one time)…");
  const failure = await new Promise((done) => {
    // stdout is PIPED and forwarded to stderr rather than inherited: Playwright's
    // installer reports its progress on stdout, and inside the MCP server that
    // is the protocol channel.
    const child = spawn(launch.command, launch.args, { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => done(code === 0 ? null : `exit ${code}`));
    child.on('error', (error) => done(String(error?.message ?? error)));
  });

  if (failure) {
    note(`[texchronicle] Could not download a browser (${failure}).`);
    return { ok: false, reason: 'failed', detail: failure };
  }
  if (!headlessShellPresent()) {
    // The installer can succeed against a different revision than the one this
    // Playwright will look for, which would otherwise be reported as a win and
    // then fail again at launch.
    note("[texchronicle] The browser download finished but Playwright's headless shell is still missing.");
    return { ok: false, reason: 'failed', detail: 'still missing' };
  }
  note('[texchronicle] Browser ready.');
  return { ok: true, reason: 'installed' };
}

/** The `postinstall` entry point. */
async function main() {
  try {
    const outcome = await ensureHeadlessShell();
    if (outcome.reason === 'present') {
      toStderr('[texchronicle] A matching Playwright browser is already installed — nothing to download.');
    }
    if (!outcome.ok && outcome.reason !== 'skipped') {
      toStderr('[texchronicle] TeXChronicle will try again the first time a preview needs a browser, and will use an installed Chrome or Edge if it still cannot.');
    }
  } catch (error) {
    toStderr(`[texchronicle] Could not check for a browser: ${String(error?.message ?? error)}`);
  }
  // Always 0. Somebody installing a LaTeX tool must not have the install fail
  // over a browser download that the server can redo on demand.
  process.exit(0);
}

// Run only when npm (or a person) invoked this file directly; importing it from
// browserHost must not start a download as a side effect of the import.
if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) main();

function sameFile(a, b) {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
