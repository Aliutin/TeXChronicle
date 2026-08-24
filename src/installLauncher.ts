// One-time Windows convenience install: a desktop + Start-menu shortcut starts
// `magictex open --desktop`, which presents the native Recent projects chooser.
// A .tex file can also be dragged onto the shortcut; Explorer appends it to argv.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const INSTALL_WINDOWS_SHORTCUTS = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('Programs')
) | Where-Object { $_ } | Select-Object -Unique
$created = @()
foreach ($folder in $folders) {
  $path = Join-Path $folder 'MagicTeX.lnk'
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $env:MAGICTEX_NODE
  $shortcut.Arguments = ('"{0}" open --desktop' -f $env:MAGICTEX_CLI)
  $shortcut.WorkingDirectory = [Environment]::GetFolderPath('MyDocuments')
  if (-not $shortcut.WorkingDirectory) { $shortcut.WorkingDirectory = $env:USERPROFILE }
  $shortcut.Description = 'Open a LaTeX project in MagicTeX'
  $shortcut.IconLocation = ('{0},0' -f $env:MAGICTEX_NODE)
  $shortcut.Save()
  $created += $path
}
$created | ConvertTo-Json -Compress`;

export interface WindowsLauncherPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function windowsLauncherPlan(
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url)),
): WindowsLauncherPlan {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return {
    command: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-STA', '-Command', INSTALL_WINDOWS_SHORTCUTS],
    env: { ...process.env, MAGICTEX_NODE: nodePath, MAGICTEX_CLI: cliPath },
  };
}

export async function installDesktopLauncher(): Promise<string[]> {
  if (process.platform !== 'win32') {
    throw new Error('The one-click shortcut installer currently supports Windows. On this system, run `magictex open` to use the graphical file picker.');
  }
  const plan = windowsLauncherPlan();
  const { stdout } = await run(plan.command, plan.args, { env: plan.env, windowsHide: true });
  const parsed = JSON.parse(stdout.trim() || '[]') as string | string[];
  const paths = Array.isArray(parsed) ? parsed : [parsed];
  return paths.filter(Boolean);
}
