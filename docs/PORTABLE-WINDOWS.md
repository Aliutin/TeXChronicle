# TeXChronicle Portable for Windows

The portable release is the easiest way to use or share TeXChronicle on a 64-bit
Windows 10/11 computer. It is a self-contained folder: no installer, administrator
rights, Node/npm, Git, Perl, TeX distribution, or first-run engine download is
required.

## Use it

1. Download `TeXChronicle-<version>-Portable-Windows-x64.zip` and its neighboring
   `.sha256` file.
2. Extract the **whole** ZIP. Do not run the EXE from inside the ZIP viewer.
3. Double-click `TeXChronicle.exe`.
4. Pick a recent paper or use **Browse…** to select its main `.tex` file. You can
   also drag a `.tex` file onto `TeXChronicle.exe`.
5. Keep the small TeXChronicle status window open while working. Closing it stops the
   local server and compiler.

The workspace opens in your default browser. TeXChronicle listens only on
`127.0.0.1`, so the editor is not exposed to other computers on the network.
Windows may show a SmartScreen warning because community builds are not currently
code-signed; verify the SHA-256 checksum before choosing **Run anyway**.

To verify the download in PowerShell:

```powershell
Get-FileHash .\TeXChronicle-*-Portable-Windows-x64.zip -Algorithm SHA256
Get-Content .\TeXChronicle-*-Portable-Windows-x64.zip.sha256
```

The two hashes must be identical.

## What travels with a project

TeXChronicle writes its durable state beside the paper:

```text
paper/
  main.tex
  ...
  .latex-preview/
    history.git/       automatic source checkpoints
    renders/           exact PDF for every successful checkpoint
    comments.json      anchored comments and their resolution state
```

That means moving or synchronizing the complete paper folder with Dropbox also
moves its timeline, historical PDFs, and comments. The **Recent projects** list is
only a convenience index stored on each computer; use Browse once on a new machine
and the project is added there.

Do not exclude `.latex-preview` from Dropbox if you want this history on every
machine. TeXChronicle already prevents its internal history and render files from
appearing as paper changes in the section diff. One machine at a time: let the
sync finish before opening the same paper elsewhere; two machines editing the
same paper offline can fork its checkpoint history.

## What is included

- the TeXChronicle application and built browser workspace;
- a private Node.js runtime;
- Git for Windows MinGit, used only for reversible history;
- the Playwright Chromium headless shell used by the compiler;
- the BusyTeX WASM engine and its offline TeX Live package assets;
- applicable license and third-party notice files.

The extracted folder is intentionally large (roughly 1 GB): most of it is the
offline TeX Live bundle and browser engine. A ZIP is used instead of one enormous
self-extracting EXE so it is transparent, checksum-friendly, can be scanned before
execution, and does not duplicate the payload into a temporary directory each run.

The bundled TeX engine covers ordinary papers offline. A project that depends on
an unbundled venue class or unusual package still needs that `.cls`/`.sty` file in
the project. If a complete TeX Live or MiKTeX installation is already present,
TeXChronicle can use it automatically for wider package compatibility; that is
optional, not a portable-runtime dependency.

## Share and update it

Send the ZIP and `.sha256` file. The recipient extracts it anywhere writable and
runs `TeXChronicle.exe`; the application never needs to live inside the paper folder.
For an update, stop TeXChronicle, extract the new release into a new folder, and discard
the old application folder after confirming the new one opens. Project history is
unaffected because it lives with the paper, not with the application.

## Build it reproducibly

On a Windows x64 development machine with Node/npm installed:

```powershell
npm ci
npm run build:portable:win
```

`npm ci` builds the workspace UI (`prepare`) and downloads Playwright's headless
Chromium (`postinstall`) — the build wants that browser, so let it run, or point
the builder at a cache you already have with `-PlaywrightDirectory` (below) and
set `TEXCHRONICLE_SKIP_BROWSER_DOWNLOAD=1`.

The builder creates `dist-portable/TeXChronicle-Portable-Windows-x64/`, runs a packaged
smoke test, and emits a versioned ZIP plus SHA-256 file. The smoke test deliberately
uses only bundled paths, compiles a real minimal paper with WASM, verifies the Git
checkpoint ref, and verifies the checkpoint's preserved PDF. Build-time downloads
are cached under `dist-portable/.cache`; recipients do not need network access for
the compiler.

Useful build overrides:

```powershell
.\scripts\build-portable.ps1 `
  -BusyTeXDirectory C:\cache\busytex `
  -PlaywrightDirectory C:\cache\ms-playwright `
  -NodeArchive C:\cache\node-win-x64.zip `
  -GitArchive C:\cache\MinGit-64-bit.zip
```

`-SkipArchive` leaves only the unpacked folder. `-SkipSmokeTest` is intended for
debugging the packager; do not publish a build that has not passed the smoke test.
