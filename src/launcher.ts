// Human-facing launch helpers. `magictex open` uses the operating system's
// file picker when no path was supplied, while drag-and-drop / "Open with"
// hands us an absolute .tex path. Keeping path resolution here makes the GUI
// and terminal entry points follow exactly the same project-root rules.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { recentProjectsPath } from './recentProjects.js';

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

const WINDOWS_RECENT_PROJECTS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MagicTeX — Recent projects'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(820, 445)
$form.MinimumSize = New-Object System.Drawing.Size(700, 400)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.AutoScaleMode = 'Dpi'

$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Open a LaTeX project'
$heading.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 15)
$heading.AutoSize = $true
$heading.Location = New-Object System.Drawing.Point(18, 16)
$form.Controls.Add($heading)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'Double-click a recent paper, or browse for its main .tex file.'
$hint.ForeColor = [System.Drawing.Color]::DimGray
$hint.AutoSize = $true
$hint.Location = New-Object System.Drawing.Point(20, 49)
$form.Controls.Add($hint)

$list = New-Object System.Windows.Forms.ListView
$list.View = 'Details'
$list.FullRowSelect = $true
$list.HideSelection = $false
$list.MultiSelect = $false
$list.Location = New-Object System.Drawing.Point(20, 78)
$list.Size = New-Object System.Drawing.Size(780, 305)
$list.Anchor = 'Top,Bottom,Left,Right'
[void]$list.Columns.Add('Project', 165)
[void]$list.Columns.Add('Main file', 165)
[void]$list.Columns.Add('Location', 325)
[void]$list.Columns.Add('Last opened', 115)
$form.Controls.Add($list)

$records = @()
try {
  if (Test-Path -LiteralPath $env:MAGICTEX_RECENTS_FILE -PathType Leaf) {
    $records = @(Get-Content -Raw -LiteralPath $env:MAGICTEX_RECENTS_FILE | ConvertFrom-Json)
  }
} catch { $records = @() }

foreach ($recent in $records) {
  $absolute = Join-Path ([string]$recent.projectRoot) ([string]$recent.mainFile)
  if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { continue }
  $projectName = Split-Path -Leaf ([string]$recent.projectRoot)
  if (-not $projectName) { $projectName = [System.IO.Path]::GetFileNameWithoutExtension([string]$recent.mainFile) }
  $when = ''
  try { $when = ([DateTimeOffset]::Parse([string]$recent.lastOpened)).LocalDateTime.ToString('g') } catch {}
  $item = New-Object System.Windows.Forms.ListViewItem($projectName)
  [void]$item.SubItems.Add([string]$recent.mainFile)
  [void]$item.SubItems.Add([string]$recent.projectRoot)
  [void]$item.SubItems.Add($when)
  $item.Tag = $recent
  [void]$list.Items.Add($item)
}

$openButton = New-Object System.Windows.Forms.Button
$openButton.Text = 'Open'
$openButton.Size = New-Object System.Drawing.Size(92, 31)
$openButton.Location = New-Object System.Drawing.Point(708, 397)
$openButton.Anchor = 'Bottom,Right'
$openButton.Enabled = $false
$form.Controls.Add($openButton)

$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Text = 'Browse…'
$browseButton.Size = New-Object System.Drawing.Size(100, 31)
$browseButton.Location = New-Object System.Drawing.Point(596, 397)
$browseButton.Anchor = 'Bottom,Right'
$form.Controls.Add($browseButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = 'Cancel'
$cancelButton.Size = New-Object System.Drawing.Size(88, 31)
$cancelButton.Location = New-Object System.Drawing.Point(20, 397)
$cancelButton.Anchor = 'Bottom,Left'
$form.Controls.Add($cancelButton)

$script:choice = $null
$openSelected = {
  if ($list.SelectedItems.Count -eq 0) { return }
  $recent = $list.SelectedItems[0].Tag
  $script:choice = [PSCustomObject]@{
    projectRoot = [string]$recent.projectRoot
    mainFile = [string]$recent.mainFile
  }
  $form.Close()
}
$list.Add_SelectedIndexChanged({ $openButton.Enabled = $list.SelectedItems.Count -gt 0 })
$list.Add_DoubleClick($openSelected)
$openButton.Add_Click($openSelected)
$browseButton.Add_Click({
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Choose the main LaTeX file'
  $dialog.Filter = 'LaTeX files (*.tex)|*.tex|All files (*.*)|*.*'
  $dialog.CheckFileExists = $true
  $dialog.Multiselect = $false
  if ($env:MAGICTEX_PICKER_DIR -and (Test-Path -LiteralPath $env:MAGICTEX_PICKER_DIR)) {
    $dialog.InitialDirectory = $env:MAGICTEX_PICKER_DIR
  }
  if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
    $script:choice = [PSCustomObject]@{
      projectRoot = Split-Path -Parent $dialog.FileName
      mainFile = Split-Path -Leaf $dialog.FileName
    }
    $form.Close()
  }
})
$cancelButton.Add_Click({ $form.Close() })
$form.AcceptButton = $openButton
$form.CancelButton = $cancelButton
$form.Add_Shown({ $form.Activate(); if ($list.Items.Count -gt 0) { $list.Items[0].Selected = $true; $list.Focus() } })

if ($env:MAGICTEX_PICKER_AUTOCLOSE -eq '1') {
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 100
  $timer.Add_Tick({ $timer.Stop(); $form.Close() })
  $timer.Start()
}
[void]$form.ShowDialog()
if ($script:choice) {
  [Console]::Out.Write(($script:choice | ConvertTo-Json -Compress))
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

export function recentProjectsPickerPlan(
  initialDirectory: string,
  recentsFile = recentProjectsPath(),
): PickerPlan {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return {
    command: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-STA', '-Command', WINDOWS_RECENT_PROJECTS],
    env: {
      ...process.env,
      MAGICTEX_PICKER_DIR: resolve(initialDirectory),
      MAGICTEX_RECENTS_FILE: recentsFile,
    },
  };
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

/** Desktop entry point. Windows gets a real recent-projects window; other
 * platforms retain their native file chooser until equivalent launchers land. */
export async function chooseLaunchTarget(initialDirectory = process.cwd()): Promise<LaunchTarget | null> {
  if (process.platform !== 'win32') {
    const selected = await chooseMainTex(initialDirectory);
    return selected ? resolveLaunchTarget(initialDirectory, undefined, selected) : null;
  }
  const plan = recentProjectsPickerPlan(initialDirectory);
  const { stdout } = await run(plan.command, plan.args, {
    env: plan.env,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const output = stdout.trim();
  if (!output) return null;
  let selected: { projectRoot?: unknown; mainFile?: unknown };
  try { selected = JSON.parse(output) as typeof selected; }
  catch { throw new Error(`The project chooser returned an invalid selection: ${output.slice(0, 200)}`); }
  if (typeof selected.projectRoot !== 'string' || typeof selected.mainFile !== 'string') {
    throw new Error('The project chooser did not return a project root and main .tex file.');
  }
  return resolveLaunchTarget(initialDirectory, selected.projectRoot, selected.mainFile);
}

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
