// One-time Windows convenience install: a desktop + Start-menu shortcut starts
// `texchronicle open --desktop`, which presents the native Recent projects chooser.
// A .tex file can also be dragged onto the shortcut; Explorer appends it to argv.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const INSTALL_WINDOWS_SHORTCUTS = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$launcherDir = Join-Path $env:LOCALAPPDATA 'TeXChronicle'
[void](New-Item -ItemType Directory -Force -Path $launcherDir)
$launcher = Join-Path $launcherDir 'launch.cmd'
$body = @"
@echo off
title TeXChronicle
where texchronicle >nul 2>nul
if errorlevel 1 goto fallback
call texchronicle open --desktop %*
goto finished
:fallback
"$env:TEXCHRONICLE_NODE" "$env:TEXCHRONICLE_CLI" open --desktop %*
:finished
set "texchronicle_exit=%errorlevel%"
if "%texchronicle_exit%"=="0" exit /b 0
echo.
echo [TeXChronicle] Startup failed with exit code %texchronicle_exit%.
echo Copy the error above when reporting the problem.
pause
exit /b %texchronicle_exit%
"@
[System.IO.File]::WriteAllText($launcher, $body, $utf8)
$shell = New-Object -ComObject WScript.Shell
$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('Programs')
) | Where-Object { $_ } | Select-Object -Unique
$created = @()
foreach ($folder in $folders) {
  $path = Join-Path $folder 'TeXChronicle.lnk'
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $launcher
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = [Environment]::GetFolderPath('MyDocuments')
  if (-not $shortcut.WorkingDirectory) { $shortcut.WorkingDirectory = $env:USERPROFILE }
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Open a LaTeX project in TeXChronicle'
  $shortcut.IconLocation = ('{0},70' -f (Join-Path $env:SystemRoot 'System32\shell32.dll'))
  $shortcut.Save()
  $created += $path
}
$json = $created | ConvertTo-Json -Compress
$bytes = $utf8.GetBytes($json)
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)`;

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
    env: { ...process.env, TEXCHRONICLE_NODE: nodePath, TEXCHRONICLE_CLI: cliPath },
  };
}

export async function installDesktopLauncher(): Promise<string[]> {
  if (process.platform !== 'win32') {
    throw new Error('The one-click shortcut installer currently supports Windows. On this system, run `texchronicle open` to use the graphical file picker.');
  }
  const plan = windowsLauncherPlan();
  const { stdout } = await run(plan.command, plan.args, { env: plan.env, windowsHide: true });
  const parsed = JSON.parse(stdout.trim() || '[]') as string | string[];
  const paths = Array.isArray(parsed) ? parsed : [parsed];
  return paths.filter(Boolean);
}
