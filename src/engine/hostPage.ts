// The HTML for the hidden page that headless Chromium loads. It imports the
// WASM TeX engine and initializes the BusyTexRunner ONCE, then exposes
// window.__compile for repeated compiles (reusing the initialized runner —
// this is the key efficiency the spike flagged: don't re-init per compile).
//
// Served over http://127.0.0.1 with COOP/COEP headers (required for the
// engine's Worker/SharedArrayBuffer) by engineServer.ts.
export function hostPageHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>latex engine host</title></head>
<body>
<script type="module">
  import { BusyTexRunner, XeLatex, PdfLatex, LuaLatex } from '/engine/index.js';

  // One runner, initialized once, reused for every compile.
  const runnerReady = (async () => {
    const runner = new BusyTexRunner({
      busytexBasePath: '/busytex',
      // .js suffix is required — names are passed raw to importScripts (spike finding).
      preloadDataPackages: ['texlive-basic.js'],
      catalogDataPackages: ['texlive-basic.js', 'texlive-recommended.js', 'texlive-extra.js'],
    });
    await runner.initialize();
    return runner;
  })();

  const ENGINES = { xelatex: XeLatex, pdflatex: PdfLatex, lualatex: LuaLatex };

  // Base64 entries (binary figures) are decoded to Uint8Array; text stays as-is.
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const materialize = (f) => (f.encoding === 'base64' ? { path: f.path, content: b64ToBytes(f.content) } : { path: f.path, content: f.content });

  // files: [{ path, content, encoding? }], mainTexPath, engine, opts
  window.__compile = async (files, mainTexPath, engine, opts) => {
    const t0 = performance.now();
    try {
      const runner = await runnerReady;
      const EngineClass = ENGINES[engine] || XeLatex;
      const eng = new EngineClass(runner);
      const mainFile = files.find((f) => f.path === mainTexPath);
      // Without this, a main file that never made it into the bundle compiled an
      // empty string: LaTeX said "Emergency stop" and the reader was left
      // debugging a document that was never sent. The list is the evidence, so
      // say what it actually contained.
      if (!mainFile) {
        return {
          success: false,
          pdfBytes: null,
          pdfLen: 0,
          log: '',
          ms: Math.round(performance.now() - t0),
          error: 'main file ' + mainTexPath + ' was not among the ' + files.length + ' files sent to the engine',
        };
      }
      const result = await eng.compile({
        // Through materialize as well: a source that is not valid UTF-8 (a
        // Latin-1 or UTF-16 paper) arrives base64-encoded like any figure, and
        // the engine writes the main file by the same path as every other one.
        input: materialize(mainFile).content,
        mainTexPath,
        additionalFiles: files.filter((f) => f.path !== mainTexPath).map(materialize),
        bibtex: !!(opts && opts.bibtex),
        rerun: !!(opts && opts.rerun),
      });
      return {
        success: !!result.success,
        exitCode: result.exitCode,
        pdfBytes: result.pdf ? Array.from(result.pdf) : null,
        pdfLen: result.pdf ? result.pdf.length : 0,
        log: result.log || '',
        ms: Math.round(performance.now() - t0),
      };
    } catch (err) {
      return { success: false, error: String((err && err.stack) || err), ms: Math.round(performance.now() - t0) };
    }
  };

  // Signal readiness only after the engine has fully initialized once.
  runnerReady.then(() => { window.__ready = true; }).catch((e) => { window.__initError = String(e); });
</script>
</body></html>`;
}
