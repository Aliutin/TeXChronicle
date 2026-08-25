// Smoke test for the path CI otherwise never touches: spawn the real MCP server
// and make it actually compile a paper — headless Chromium, the WASM TeX Live
// engine, asset resolution, main-file detection, the lot.
//
// Why this exists as its own script rather than a `node --test` case: the test
// suite is deliberately fast and browser-free, and the engine only loads on the
// first render_preview. v0.1.0 shipped installable-but-broken exactly because
// verification stopped at "server started" and never reached that lazy load.
// This is the check that would have caught it.
//
//   node scripts/smoke-compile.mjs [projectDir]
//
// Exits non-zero with a reason on any failure, so CI and humans read it the same.
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = process.argv[2] ?? join(REPO, 'examples', 'minimal-paper');

// A first run downloads ~480 MB of engine assets, so allow for it; a warm run
// finishes in seconds.
const COMPILE_TIMEOUT_MS = 15 * 60 * 1000;

const fail = (why) => { console.error(`SMOKE FAIL: ${why}`); process.exit(1); };

if (!existsSync(SOURCE)) fail(`no such project: ${SOURCE}`);

// Copy the sample out of the repo: compiling writes artifacts and (in a git
// repo) checkpoints, and the smoke test shouldn't leave either behind.
const proj = mkdtempSync(join(tmpdir(), 'texchronicle-smoke-'));
cpSync(SOURCE, proj, { recursive: true });

const started = Date.now();
let client;
try {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(REPO, 'src', 'server.ts')],
    cwd: proj,
  });
  client = new Client({ name: 'smoke', version: '0' }, { capabilities: {} });
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  if (!tools.includes('render_preview')) fail(`render_preview missing; got ${tools.join(', ')}`);
  console.log(`platform ${process.platform}/${process.arch} · node ${process.version} · ${tools.length} tools`);

  // Pinned to wasm: this script exists to prove the bundled engine works on a
  // clean machine. Under the 'auto' default a runner that has latexmk installed
  // would compile with system TeX, and the WASM path — the whole point here —
  // would go untested while the script still passed.
  const result = await client.callTool(
    { name: 'render_preview', arguments: { backend: 'wasm' } },
    undefined,
    { timeout: COMPILE_TIMEOUT_MS },
  );
  const text = result.content.map((c) => c.text ?? '').join('\n');
  console.log(text.split('\n')[0]);

  if (!/✓ Compiled/.test(text)) fail(`compile did not succeed:\n${text.slice(0, 800)}`);

  // "Compiled" is the server's own claim — go fetch the artifact it points at
  // and check there's a real PDF behind it.
  const base = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!base) fail('no workspace URL in the tool result');

  const res = await fetch(`${base}/latest.pdf`);
  if (!res.ok) fail(`GET /latest.pdf → ${res.status}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.length < 1000) fail(`PDF suspiciously small: ${pdf.length} bytes`);
  if (pdf.subarray(0, 5).toString() !== '%PDF-') fail('response is not a PDF (bad magic bytes)');

  const app = await fetch(`${base}/app`);
  if (!app.ok) fail(`workspace not served: /app → ${app.status}`);

  console.log(`pdf ${pdf.length} bytes · workspace served · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('SMOKE PASS');
} finally {
  try { await client?.close(); } catch { /* transport already gone */ }
  // Windows keeps handles on the temp dir briefly after the child exits; a
  // failed cleanup must not turn a passing smoke test red.
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(0);
