// Human-facing launcher for the browser workspace. MCP remains an optional
// control surface: this starts the same preview server, compiler, watcher and
// history loop directly from a terminal, without an LLM or MCP client.
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import open from 'open';
import { setConfig, requestCompile } from './coordinator.js';
import { getPreview, shutdownEngine } from './engine/browserHost.js';
import { summarizeErrors } from './project/parseLog.js';
import type { Backend, Engine } from './project/compileProject.js';
import { startWatching, stopWatching } from './watch/fileWatcher.js';
import { canonicalizeLaunchTarget, chooseLaunchTarget, inferLaunchTarget, resolveLaunchTarget } from './launcher.js';
import { rememberRecentProject } from './recentProjects.js';
import { resolveMainFile } from './project/resolveMainFile.js';
import { acquireProjectInstance, type OwnedProjectInstance } from './projectInstance.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENGINES = new Set<Engine>(['xelatex', 'pdflatex', 'lualatex']);
const BACKENDS = new Set<Backend>(['auto', 'system', 'wasm']);
const SHUTDOWN_BUDGET_MS = 3000;
const launcherPid = process.ppid;
let launcherWatch: NodeJS.Timeout | null = null;
let ownedInstance: OwnedProjectInstance | null = null;

const HELP = `Open a TeXChronicle workspace without an LLM.

Usage:
  texchronicle preview [main.tex] [options]
  texchronicle open                       Reopen a recent project or browse for .tex
  texchronicle install-launcher           Add Desktop + Start-menu shortcuts (Windows)

Options:
  -p, --project <directory>    Project root (default: current directory)
      --engine <name>          xelatex, pdflatex, or lualatex (default: auto-detect)
      --backend <name>         auto, system, or wasm (default: auto)
      --shell-escape           Permit shell escape with the system backend
      --no-open                Print the URL without launching a browser
      --exit-after-initial-compile
                              Stop after the first compile (portable/CI diagnostics)
  -h, --help                   Show this help

Examples:
  texchronicle preview main.tex
  texchronicle open
  texchronicle preview -p "C:\\papers\\study" paper.tex

Keep this terminal open while editing. Press Ctrl+C to stop TeXChronicle.`;

let shutdownRun: Promise<void> | null = null;
function shutdown(why: string): Promise<void> {
  shutdownRun ??= (async () => {
    console.log(`\n[TeXChronicle] stopping (${why})…`);
    if (launcherWatch) clearInterval(launcherWatch);
    launcherWatch = null;
    await stopWatching().catch(() => {});
    await shutdownEngine().catch(() => {});
    await ownedInstance?.release().catch(() => {});
    ownedInstance = null;
  })();
  return shutdownRun;
}

function shutdownAndExit(why: string, code = 0): void {
  const bail = new Promise<void>((done) => setTimeout(done, SHUTDOWN_BUDGET_MS).unref());
  void Promise.race([shutdown(why), bail]).then(() => process.exit(code));
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => shutdownAndExit(signal));
}

function enableLifecycleMonitoring(desktopMode = false): void {
  // Explorer gives a directly-launched console process no durable stdin and a
  // long-lived explorer.exe parent. Neither is a meaningful lifetime signal.
  // In desktop mode the visible status window is the stop control: closing it
  // terminates Node and the OS releases the local listener.
  if (desktopMode) return;
  // On Windows a terminal wrapper can receive Ctrl+C itself and disappear
  // without forwarding SIGINT to Node. Its stdin pipe usually closes.
  process.stdin.resume();
  process.stdin.on('close', () => shutdownAndExit('terminal closed'));

  // Some shells neither forward Ctrl+C nor close the inherited console handle.
  // The Node process then becomes an orphan with an open port. Remember the
  // wrapper that launched us and stop when it disappears.
  if (launcherPid > 0) {
    launcherWatch = setInterval(() => {
      try { process.kill(launcherPid, 0); }
      catch { shutdownAndExit('launcher exited'); }
    }, 1000);
    launcherWatch.unref();
  }
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: process.argv.slice(3),
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: 'string', short: 'p' },
        engine: { type: 'string' },
        backend: { type: 'string' },
        'shell-escape': { type: 'boolean' },
        'no-open': { type: 'boolean' },
        desktop: { type: 'boolean' },
        'exit-after-initial-compile': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n\n${HELP}`);
  }

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`Expected at most one main .tex file.\n\n${HELP}`);
  }

  const engine = parsed.values.engine as Engine | undefined;
  const backend = parsed.values.backend as Backend | undefined;
  if (engine && !ENGINES.has(engine)) {
    throw new Error(`Unknown engine "${engine}". Choose xelatex, pdflatex, or lualatex.`);
  }
  if (backend && !BACKENDS.has(backend)) {
    throw new Error(`Unknown backend "${backend}". Choose auto, system, or wasm.`);
  }

  const projectOption = typeof parsed.values.project === 'string' ? parsed.values.project : undefined;
  const rawMain: string | undefined = parsed.positionals[0];
  let launchTarget;
  if (process.argv[2] === 'open' && !rawMain && !projectOption) {
    launchTarget = await chooseLaunchTarget(process.cwd());
    if (!launchTarget) {
      console.log('[TeXChronicle] No file selected.');
      return;
    }
  } else {
    launchTarget = !projectOption && rawMain && isAbsolute(rawMain)
      ? await inferLaunchTarget(process.cwd(), rawMain)
      : resolveLaunchTarget(process.cwd(), projectOption, rawMain);
  }
  launchTarget = await canonicalizeLaunchTarget(launchTarget);
  const { projectRoot } = launchTarget;
  const projectInfo = await stat(projectRoot).catch(() => null);
  if (!projectInfo?.isDirectory()) throw new Error(`Project directory does not exist: ${projectRoot}`);
  const resolvedMain = await resolveMainFile(projectRoot, launchTarget.mainFile);
  const checkedMain = await canonicalizeLaunchTarget({ projectRoot, mainFile: resolvedMain });
  const mainFile = checkedMain.mainFile!;

  // Remember the valid selection before starting a server or a potentially long
  // first compile. Closing the window during startup must not make the project
  // disappear from Recent projects.
  await rememberRecentProject(projectRoot, mainFile).catch((error) => {
    console.warn(`[TeXChronicle] could not update Recent projects: ${(error as Error).message}`);
  });

  const instance = await acquireProjectInstance(projectRoot);
  if (!instance.owned) {
    if (!instance.url) throw new Error(`This project is already starting in another TeXChronicle process${instance.pid ? ` (PID ${instance.pid})` : ''}. Try again in a moment.`);
    console.log(`[TeXChronicle] project is already open: ${instance.url}`);
    if (!parsed.values['no-open']) await open(instance.url).catch(() => {});
    return;
  }
  ownedInstance = instance;

  const desktopMode = parsed.values.desktop === true;
  enableLifecycleMonitoring(desktopMode);
  setConfig({
    projectRoot,
    mainFile,
    engine,
    backend,
    shellEscape: parsed.values['shell-escape'] === true,
  });
  startWatching(projectRoot);

  const preview = await getPreview();
  const hasWorkspace = existsSync(join(PKG_ROOT, 'ui', 'dist', 'index.html'));
  const workspaceUrl = hasWorkspace ? `${preview.url}/app` : preview.viewerUrl;
  await ownedInstance.publish(workspaceUrl);

  console.log(`[TeXChronicle] project: ${projectRoot}`);
  console.log(`[TeXChronicle] workspace: ${workspaceUrl}`);
  console.log(desktopMode
    ? '[TeXChronicle] watching for edits; close this window to stop.'
    : '[TeXChronicle] watching for edits; press Ctrl+C to stop.');
  if (!parsed.values['no-open']) {
    await open(workspaceUrl).catch((error) => {
      console.warn(`[TeXChronicle] could not open the browser: ${(error as Error).message}`);
    });
  }

  console.log('[TeXChronicle] initial compile running — the first PDF and History checkpoint appear together after it succeeds.');
  const result = await requestCompile();
  const errors = result.verdict?.errors.length ?? 0;
  const clean = result.success && errors === 0;
  if (clean) {
    console.log(`[TeXChronicle] ✓ ${result.mainFile}: ${result.engine} · ${result.backend}, ${result.ms}ms`);
  } else if (result.success) {
    console.warn(`[TeXChronicle] ⚠ ${result.mainFile} rendered with ${errors} error${errors === 1 ? '' : 's'}; the previous clean PDF is preserved.`);
    console.warn(summarizeErrors(result.log || ''));
  } else {
    console.error(`[TeXChronicle] ✖ ${result.mainFile} failed to compile.`);
    console.error(summarizeErrors(result.log || result.error || ''));
  }

  if (parsed.values['exit-after-initial-compile']) {
    if (clean) console.log('[TeXChronicle] PORTABLE_SELF_TEST_OK');
    else process.exitCode = 1;
    await shutdown('initial compile complete');
  }
}

main().catch(async (error) => {
  console.error(`[TeXChronicle] ${String((error as Error).message ?? error)}`);
  await shutdown('startup error');
  process.exitCode = 1;
});
