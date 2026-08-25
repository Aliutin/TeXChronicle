// Singleton headless-Chromium host. Launches the browser + engine page ONCE
// (the WASM engine initializes once and is reused across compiles), and drives
// compiles via page.evaluate. This is the Node<->browser bridge that exists
// solely because the WASM TeX engines require DOM/Worker globals (spike finding).
import { chromium, type Browser, type Page } from 'playwright';
import { startPreviewServer, type PreviewServerHandle } from '../preview/previewServer.js';
import { ensureAssets } from './assets.js';
import { stopSystemTex } from './systemTex.js';

export interface EngineFile {
  path: string;
  content: string; // text as-is; binary content is base64-encoded
  encoding?: 'utf8' | 'base64';
}

export interface CompileOutput {
  success: boolean;
  exitCode?: number;
  pdf?: Uint8Array;
  /** Compiler-generated source map for the PDF. Only the system backend can
   *  provide this; the bundled WASM engine has no SyncTeX output. */
  syncTex?: Uint8Array;
  pdfLen: number;
  log: string;
  ms: number;
  error?: string;
}

// Three tiers, started independently, because they cost wildly different things.
// Folding them into one call meant `render_preview` downloaded 480 MB of WASM
// engine before it had even decided whether to use the system backend — so
// installing a real TeX, the thing that makes the WASM engine unnecessary, was
// what triggered the download.
let serverStarted: Promise<PreviewServerHandle> | null = null;
let browserStarted: Promise<{ browser: Browser; preview: PreviewServerHandle }> | null = null;
let engineStarted: Promise<{ browser: Browser; page: Page; preview: PreviewServerHandle }> | null = null;

let currentPreview: PreviewServerHandle | null = null; // set once the server is up

// Set before shutdown starts tearing anything down, and never cleared. Teardown
// is not instantaneous, and the server keeps answering requests while it runs —
// so a tool call or a debounced watcher compile arriving in that window used to
// find the tier handles already nulled and cheerfully build a NEW preview server
// (on a new port) and a NEW Chromium, moments before process.exit reclaimed the
// process and orphaned them. That is the exact leak this file's shutdown exists
// to prevent, reintroduced by the shutdown itself.
let disposed = false;

// The teardown budget is a few seconds (see src/server.ts); Chromium gets most
// of it, but not all, so a wedged browser cannot cost us the port as well.
const BROWSER_CLOSE_MS = 2000;

/** Thrown when something asks for an engine tier after shutdown began. */
class ShuttingDownError extends Error {
  constructor() { super('TeXChronicle is shutting down.'); this.name = 'ShuttingDownError'; }
}

/** Tier 1 — the local HTTP server behind the workspace, /latest.pdf and the WS
 *  push. Needed by every code path; costs a port. It serves /busytex/* lazily
 *  per request, so it does not need the engine assets to exist. */
export function ensureServer(): Promise<PreviewServerHandle> {
  if (disposed) return Promise.reject(new ShuttingDownError());
  serverStarted ??= startPreviewServer().then((preview) => {
    currentPreview = preview;
    return preview;
  });
  return serverStarted;
}

/**
 * Playwright downloads no browser when it is installed — 1.62 has no postinstall
 * hook — so a plain `npm install` leaves this launch to fail. Its own error is an
 * ASCII-art box beginning "Looks like Playwright was just installed", written for
 * a terminal; relayed through MCP it reaches the reader as a wall of box-drawing
 * characters around a command that is not the one they need. Say the one command
 * that fixes it, and where to run it.
 *
 * Exported so the mapping can be tested without a missing browser.
 */
export function browserLaunchHelp(error: unknown): string | null {
  const message = String((error as Error)?.message ?? error);
  if (!/Executable doesn't exist/i.test(message)) return null;
  return "TeXChronicle needs Playwright's Chromium and it is not installed. Run:\n"
    + '  npx --no-install playwright install chromium --only-shell\n'
    + 'in the TeXChronicle folder, then restart your MCP client.';
}

/** Tier 2 — headless Chromium. Needed to screenshot the diff page; no TeX
 *  engine and no assets involved. */
function ensureBrowser() {
  if (disposed) return Promise.reject(new ShuttingDownError());
  browserStarted ??= (async () => {
    const preview = await ensureServer();
    const browser = await chromium.launch({ headless: true }).catch((error: unknown) => {
      const help = browserLaunchHelp(error);
      if (help) throw new Error(help);
      throw error;
    });
    return { browser, preview };
  })();
  return browserStarted;
}

/** Tier 3 — the WASM TeX engine: the ~650 MB asset download plus a page that
 *  initializes busytex. Only a wasm-backend compile needs this. */
export function ensureEngine() {
  if (disposed) return Promise.reject(new ShuttingDownError());
  engineStarted ??= (async () => {
    const { browser, preview } = await ensureBrowser();
    await ensureAssets(); // fetch WASM assets on first run if missing
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[engine page error]', e.message));
    await page.goto(`${preview.url}/host.html`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction('window.__ready === true || window.__initError', { timeout: 120_000 });
    const initError = await page.evaluate('window.__initError');
    if (initError) throw new Error(`Engine failed to initialize: ${initError}`);
    return { browser, page, preview };
  })();
  return engineStarted;
}

/** The workspace URL callers need. Deliberately tier 1: opening the workspace
 *  must not pull in a browser or an engine download. */
export async function getPreview(): Promise<PreviewServerHandle> {
  return ensureServer();
}

/** The preview handle *if the engine is already running*, else null — never
 *  starts it. For cheap best-effort broadcasts (e.g. resolve_comment) that must
 *  not block a loop by cold-starting the whole browser + WASM engine. */
export function peekPreview(): PreviewServerHandle | null {
  return currentPreview;
}

export async function compile(
  files: EngineFile[],
  mainTexPath: string,
  engine: 'xelatex' | 'pdflatex' | 'lualatex' = 'xelatex',
  opts: { bibtex?: boolean; rerun?: boolean } = {},
): Promise<CompileOutput> {
  const { page } = await ensureEngine();
  const raw = (await page.evaluate(
    // eslint-disable-next-line no-undef
    ([f, m, e, o]) => (window as any).__compile(f, m, e, o),
    [files, mainTexPath, engine, opts] as const,
  )) as { success: boolean; exitCode?: number; pdfBytes: number[] | null; pdfLen: number; log?: string; ms: number; error?: string };

  return {
    success: raw.success,
    exitCode: raw.exitCode,
    pdf: raw.pdfBytes ? Uint8Array.from(raw.pdfBytes) : undefined,
    pdfLen: raw.pdfLen ?? 0,
    log: raw.log ?? '',
    ms: raw.ms,
    error: raw.error,
  };
}

/**
 * Open the side-by-side diff page, wait for it to render, and screenshot it.
 * Returns { empty: true } when there's nothing to diff. Used by the show_diff
 * tool to return a diff image inline in the conversation.
 */
export async function captureDiff(path: string): Promise<{ empty: boolean; png?: Buffer }> {
  // Tier 2: this screenshots an HTML page. It has never needed a TeX engine, and
  // shouldn't trigger the asset download just to show a diff.
  const { browser, preview } = await ensureBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(`${preview.url}${path}`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction('window.__rendered === true', { timeout: 20_000 });
    if (await page.evaluate('window.__empty === true')) return { empty: true };
    const el = await page.$('#diff');
    const png = el ? await el.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png', fullPage: true });
    return { empty: false, png: png as Buffer };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Tear down whichever tiers actually started — the browser may never have been
 *  launched (system backend), and the server may be the only thing running. */
export async function shutdownEngine() {
  // First, and before any await: from here on, nothing may build a new tier.
  // Previously the handles were nulled at the END, which is the one arrangement
  // that lets an in-flight compile rebuild everything mid-teardown.
  disposed = true;
  // First: a long latexmk tree must not outlive the status window while the
  // slower browser/socket teardown consumes the exit budget. The kill happens
  // before stopSystemTex's first await; it then removes this process's aux dir.
  await stopSystemTex();

  // The preview server goes first. It is the fast, user-visible half — closing it
  // is what tells open windows they have gone stale — while browser.close() can
  // take hundreds of milliseconds or, on a wedged Chromium, hang. Doing the
  // browser first meant a hung browser stopped the tabs from ever being told.
  if (serverStarted) {
    const preview = await serverStarted.catch(() => null);
    // `close()`, not `server.close()`: the latter waits on open connections, and
    // a WebSocket is open by design.
    await preview?.close().catch(() => {});
  }
  if (browserStarted) {
    const { browser } = await browserStarted.catch(() => ({ browser: null }));
    // Bounded. `.catch()` covers a rejection, not a hang, and Playwright's
    // close() can hang on a wedged browser process — which would swallow the
    // caller's whole shutdown budget and get us SIGKILLed holding the port too.
    await Promise.race([
      browser?.close().catch(() => {}) ?? Promise.resolve(),
      new Promise<void>((r) => setTimeout(r, BROWSER_CLOSE_MS).unref()),
    ]);
  }
  serverStarted = null;
  browserStarted = null;
  engineStarted = null;
  currentPreview = null;
}

/** Test-only: undo `disposed` so a suite can start a fresh host in-process. */
export function __resetForTests() {
  disposed = false;
  serverStarted = null;
  browserStarted = null;
  engineStarted = null;
  currentPreview = null;
}
