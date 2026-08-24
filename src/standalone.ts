// Human-facing launcher for the browser workspace. MCP remains an optional
// control surface: this starts the same preview server, compiler, watcher and
// history loop directly from a terminal, without an LLM or MCP client.
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import open from 'open';
import { setConfig, requestCompile } from './coordinator.js';
import { getPreview, shutdownEngine } from './engine/browserHost.js';
import { summarizeErrors } from './project/parseLog.js';
import type { Backend, Engine } from './project/compileProject.js';
import { startWatching, stopWatching } from './watch/fileWatcher.js';
import { chooseLaunchTarget, resolveLaunchTarget } from './launcher.js';
import { rememberRecentProject } from './recentProjects.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENGINES = new Set<Engine>(['xelatex', 'pdflatex', 'lualatex']);
const BACKENDS = new Set<Backend>(['auto', 'system', 'wasm']);
const SHUTDOWN_BUDGET_MS = 3000;
const launcherPid = process.ppid;
let launcherWatch: NodeJS.Timeout | null = null;

const HELP = `Open a MagicTeX workspace without an LLM.

Usage:
  magictex preview [main.tex] [options]
  magictex open                       Reopen a recent project or browse for .tex
  magictex install-launcher           Add Desktop + Start-menu shortcuts (Windows)
  magictex-mcp preview [main.tex] [options]

Options:
  -p, --project <directory>    Project root (default: current directory)
      --engine <name>          xelatex, pdflatex, or lualatex (default: auto-detect)
      --backend <name>         auto, system, or wasm (default: auto)
      --shell-escape           Permit shell escape with the system backend
      --no-open                Print the URL without launching a browser
  -h, --help                   Show this help

Examples:
  magictex preview main.tex
  magictex open
  magictex preview -p "C:\\papers\\study" paper.tex

Keep this terminal open while editing. Press Ctrl+C to stop MagicTeX.`;

let shutdownRun: Promise<void> | null = null;
function shutdown(why: string): Promise<void> {
  shutdownRun ??= (async () => {
    console.log(`\n[MagicTeX] stopping (${why})…`);
    if (launcherWatch) clearInterval(launcherWatch);
    launcherWatch = null;
    await stopWatching().catch(() => {});
    await shutdownEngine().catch(() => {});
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
      console.log('[MagicTeX] No file selected.');
      return;
    }
  } else {
    launchTarget = resolveLaunchTarget(process.cwd(), projectOption, rawMain);
  }
  const { projectRoot, mainFile } = launchTarget;
  const projectInfo = await stat(projectRoot).catch(() => null);
  if (!projectInfo?.isDirectory()) throw new Error(`Project directory does not exist: ${projectRoot}`);

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

  console.log(`[MagicTeX] project: ${projectRoot}`);
  console.log(`[MagicTeX] workspace: ${workspaceUrl}`);
  console.log(desktopMode
    ? '[MagicTeX] watching for edits; close this window to stop.'
    : '[MagicTeX] watching for edits; press Ctrl+C to stop.');
  if (!parsed.values['no-open']) {
    await open(workspaceUrl).catch((error) => {
      console.warn(`[MagicTeX] could not open the browser: ${(error as Error).message}`);
    });
  }

  console.log('[MagicTeX] initial compile running — the first PDF and History checkpoint appear together after it succeeds.');
  const result = await requestCompile();
  await rememberRecentProject(projectRoot, result.mainFile).catch((error) => {
    console.warn(`[MagicTeX] could not update Recent projects: ${(error as Error).message}`);
  });
  const errors = result.verdict?.errors.length ?? 0;
  if (result.success && errors === 0) {
    console.log(`[MagicTeX] ✓ ${result.mainFile}: ${result.engine} · ${result.backend}, ${result.ms}ms`);
  } else if (result.success) {
    console.warn(`[MagicTeX] ⚠ ${result.mainFile} rendered with ${errors} error${errors === 1 ? '' : 's'}; the previous clean PDF is preserved.`);
    console.warn(summarizeErrors(result.log || ''));
  } else {
    console.error(`[MagicTeX] ✖ ${result.mainFile} failed to compile.`);
    console.error(summarizeErrors(result.log || result.error || ''));
  }
}

main().catch(async (error) => {
  console.error(`[MagicTeX] ${String((error as Error).message ?? error)}`);
  await shutdown('startup error');
  process.exitCode = 1;
});
