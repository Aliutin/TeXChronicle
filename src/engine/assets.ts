// The TeX Live WASM assets (~480MB download, ~649MB on disk) are NOT committed to
// git — they're fetched once on first run into a per-user cache (see assetsDir.ts
// for why not into the package directory). Progress streams to stderr (stdout is
// the MCP JSON-RPC channel and must stay clean).
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { busytexDir, busytexDownloadDest, busytexPresent } from './assetsDir.js';

const requireFrom = createRequire(import.meta.url);

/**
 * How to launch the downloader.
 *
 * It used to be `spawn('npx', [...], { shell: process.platform === 'win32' })`,
 * to reach `npx.cmd`. But with `shell: true` Node does not pass an argv — it
 * joins the arguments with spaces into one command line and hands that to the
 * shell, without quoting any of them. The destination is
 * a per-user cache, so for anyone whose Windows account name has a
 * space in it the child saw:
 *
 *   ["download-assets", "C:\\Users\\A", "User\\AppData\\Local\\texchronicle"]
 *
 * and the 480 MB first-run download went to `C:\Users\A` — or failed. Every
 * such user hit it on their very first compile, which is the worst possible
 * moment for the tool to look broken.
 *
 * Quoting the path would work; not needing a shell works better. The package is
 * a dependency of this one, so its CLI is a file on disk we can run with the
 * node we are already running — no shell, no quoting rules, no PATH lookup, and
 * no npx reaching for the network to fetch something already installed.
 *
 * Exported so a test can check what would be launched without spending 480 MB.
 */
export function downloadCommand(dest: string): { command: string; args: string[] } {
  const pkgPath = requireFrom.resolve('texlyre-busytex/package.json');
  const bin = (requireFrom(pkgPath) as { bin?: string | Record<string, string> }).bin;
  // Read from `bin` rather than hardcoding the path: it is the package's own
  // statement of where its entry point is, and it costs nothing to believe it.
  const rel = typeof bin === 'string' ? bin : bin?.['texlyre-busytex'];
  if (!rel) throw new Error(`texlyre-busytex declares no CLI entry point. Run manually: npx texlyre-busytex download-assets "${dest}"`);
  return { command: process.execPath, args: [join(dirname(pkgPath), rel), 'download-assets', dest] };
}

export async function ensureAssets(): Promise<void> {
  if (busytexPresent()) return;

  const dest = busytexDownloadDest();
  await mkdir(dest, { recursive: true });

  console.error(`[texchronicle] First run: downloading TeX Live WASM assets (~480 MB, one time) into ${busytexDir()}. This can take a few minutes…`);
  await new Promise<void>((resolve, reject) => {
    const { command, args } = downloadCommand(dest);
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`asset download failed (exit ${code}). Run manually: npx texlyre-busytex download-assets "${dest}"`))));
    child.on('error', reject);
  });

  if (!busytexPresent()) {
    throw new Error(`Assets download finished but busytex.wasm is still missing from ${busytexDir()}. Run manually: npx texlyre-busytex download-assets "${dest}"`);
  }
  console.error('[texchronicle] Assets ready.');
}
