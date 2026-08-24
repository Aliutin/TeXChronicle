// Human-facing launch helpers. `magictex open` uses the operating system's
// file picker when no path was supplied, while drag-and-drop / "Open with"
// hands us an absolute .tex path. Keeping path resolution here makes the GUI
// and terminal entry points follow exactly the same project-root rules.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const run = promisify(execFile);

export interface PickerPlan {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const WINDOWS_PICKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose the main LaTeX file'
$dialog.Filter = 'LaTeX files (*.tex)|*.tex|All files (*.*)|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
if ($env:MAGICTEX_PICKER_DIR -and (Test-Path -LiteralPath $env:MAGICTEX_PICKER_DIR)) {
  $dialog.InitialDirectory = $env:MAGICTEX_PICKER_DIR
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}`;

/** Commands are exported so the platform-specific quoting can be tested
 * without opening a real dialog in CI. Linux tries both common pickers. */
export function pickerPlans(platform: NodeJS.Platform, initialDirectory: string): PickerPlan[] {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return [{
      command: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-STA', '-Command', WINDOWS_PICKER],
      env: { ...process.env, MAGICTEX_PICKER_DIR: resolve(initialDirectory) },
    }];
  }
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: ['-e', 'POSIX path of (choose file with prompt "Choose the main LaTeX file")'],
    }];
  }
  return [
    {
      command: 'zenity',
      args: ['--file-selection', '--title=Choose the main LaTeX file', '--file-filter=LaTeX files | *.tex'],
    },
    {
      command: 'kdialog',
      args: ['--getopenfilename', resolve(initialDirectory), 'LaTeX files (*.tex)'],
    },
  ];
}

/** Open a native file chooser. Empty means the user cancelled. */
export async function chooseMainTex(initialDirectory = process.cwd()): Promise<string | null> {
  let unavailable: unknown;
  for (const plan of pickerPlans(process.platform, initialDirectory)) {
    try {
      const { stdout } = await run(plan.command, plan.args, {
        env: plan.env,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const selected = stdout.trim();
      if (!selected) return null;
      if (!/\.tex$/i.test(selected)) throw new Error(`Please choose a .tex file, not: ${selected}`);
      return resolve(selected);
    } catch (error) {
      const code = (error as { code?: string | number }).code;
      // Dialog cancellation is normally exit 1 on macOS/Linux. An absent Linux
      // picker is ENOENT, in which case try the next common one.
      if (code === 1 || code === '1') return null;
      if (code === 'ENOENT') { unavailable = error; continue; }
      throw error;
    }
  }
  throw new Error(
    `No graphical file picker is installed (${String((unavailable as Error)?.message ?? unavailable)}). ` +
    'Install zenity or kdialog, or run magictex preview from the project directory.',
  );
}

export interface LaunchTarget { projectRoot: string; mainFile?: string }

/** Resolve a terminal path, picker result, dropped file, or "Open with" path. */
export function resolveLaunchTarget(
  cwd: string,
  projectOption?: string,
  rawMain?: string,
): LaunchTarget {
  const absoluteMain = rawMain && isAbsolute(rawMain) ? resolve(rawMain) : undefined;
  const projectRoot = resolve(projectOption ?? (absoluteMain ? dirname(absoluteMain) : cwd));
  if (!rawMain) return { projectRoot };

  const mainFile = relative(projectRoot, absoluteMain ?? resolve(projectRoot, rawMain)).replace(/\\/g, '/');
  if (!mainFile || mainFile === '..' || mainFile.startsWith('../') || isAbsolute(mainFile)) {
    throw new Error('The main file must stay inside the project root.');
  }
  if (!/\.tex$/i.test(mainFile)) throw new Error(`The main file must be a .tex file: ${rawMain}`);
  return { projectRoot, mainFile };
}
