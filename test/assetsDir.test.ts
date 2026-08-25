import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// assetsDir resolves against its own file location, so each case gets a
// throwaway copy of the module in a tree we control — that's the only way to
// exercise "a fresh install with no assets" from a checkout that has them.
// fileURLToPath, not .pathname — the latter leaves a space in the checkout path
// percent-encoded as %20 and the read fails.
const SRC = fileURLToPath(new URL('../src/engine/assetsDir.ts', import.meta.url));
const SOURCE = readFileSync(SRC, 'utf8');

let seq = 0;
async function loadIn(opts: { withAssets: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'assetsdir-'));
  mkdirSync(join(root, 'src', 'engine'), { recursive: true });
  writeFileSync(join(root, 'src', 'engine', 'assetsDir.ts'), SOURCE);
  if (opts.withAssets) {
    mkdirSync(join(root, 'assets', 'busytex'), { recursive: true });
    writeFileSync(join(root, 'assets', 'busytex', 'busytex.wasm'), 'not really wasm');
  }
  const url = `file:///${join(root, 'src', 'engine', 'assetsDir.ts').replace(/\\/g, '/')}?n=${seq++}`;
  const mod = await import(url);
  return { mod, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('an install that already has the assets keeps using them', async () => {
  // Nobody should re-download 480 MB because we changed where NEW installs put
  // things. This covers a git checkout and anyone upgrading from <= 0.1.4.
  const { mod, root, cleanup } = await loadIn({ withAssets: true });
  try {
    assert.equal(mod.busytexDir(), join(root, 'assets', 'busytex'));
    assert.equal(mod.busytexPresent(), true);
  } finally {
    cleanup();
  }
});

test('a fresh install resolves outside the package directory', async () => {
  // The whole point: `npx texchronicle` installs into a cache entry npm
  // replaces wholesale on upgrade. Assets stored under it are deleted every
  // release, which is the 480 MB re-download this avoids.
  const { mod, root, cleanup } = await loadIn({ withAssets: false });
  try {
    const dir = mod.busytexDir();
    assert.ok(!dir.startsWith(root), `expected a path outside ${root}, got ${dir}`);
    assert.ok(dir.startsWith(homedir()), `expected a per-user cache path, got ${dir}`);
    // Deliberately no assertion about busytexPresent() here: it reports on the
    // *machine's* cache, so a developer who has ever downloaded the engine would
    // fail a test about where new installs resolve to. Presence is covered above
    // against a tree this test controls.
  } finally {
    cleanup();
  }
});

test('TEXCHRONICLE_ASSETS_DIR overrides even when the package has its own copy', async () => {
  const prev = process.env.TEXCHRONICLE_ASSETS_DIR;
  process.env.TEXCHRONICLE_ASSETS_DIR = join(tmpdir(), 'chosen-by-hand');
  const { mod, cleanup } = await loadIn({ withAssets: true });
  try {
    assert.equal(mod.busytexDir(), join(tmpdir(), 'chosen-by-hand'));
  } finally {
    cleanup();
    if (prev === undefined) delete process.env.TEXCHRONICLE_ASSETS_DIR;
    else process.env.TEXCHRONICLE_ASSETS_DIR = prev;
  }
});

test('the former assets environment variable remains a migration alias', async () => {
  const current = process.env.TEXCHRONICLE_ASSETS_DIR;
  const legacy = process.env.MAGICTEX_ASSETS_DIR;
  delete process.env.TEXCHRONICLE_ASSETS_DIR;
  process.env.MAGICTEX_ASSETS_DIR = join(tmpdir(), 'legacy-choice');
  const { mod, cleanup } = await loadIn({ withAssets: true });
  try {
    assert.equal(mod.busytexDir(), join(tmpdir(), 'legacy-choice'));
  } finally {
    cleanup();
    if (current === undefined) delete process.env.TEXCHRONICLE_ASSETS_DIR;
    else process.env.TEXCHRONICLE_ASSETS_DIR = current;
    if (legacy === undefined) delete process.env.MAGICTEX_ASSETS_DIR;
    else process.env.MAGICTEX_ASSETS_DIR = legacy;
  }
});

test('the download destination is the parent, since the tool creates busytex/', async () => {
  // texlyre-busytex download-assets <dest> writes <dest>/busytex. Passing the
  // busytex dir itself would nest it: <cache>/busytex/busytex.
  const { mod, cleanup } = await loadIn({ withAssets: false });
  try {
    assert.equal(join(mod.busytexDownloadDest(), 'busytex'), mod.busytexDir());
  } finally {
    cleanup();
  }
});
