[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PackageRoot,
  [ValidateRange(30, 900)]
  [int] $TimeoutSeconds = 240,
  [switch] $KeepSmokeProject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string] $Message) {
  Write-Host "[portable verify] $Message" -ForegroundColor Cyan
}

function Require-File([string] $Path, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
}

function Require-Directory([string] $Path, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label is missing: $Path"
  }
}

function Quote-ProcessArgument([string] $Value) {
  if ($Value.Contains('"')) { throw "A smoke-test path contains an unsupported quote: $Value" }
  return '"' + $Value + '"'
}

$root = [IO.Path]::GetFullPath($PackageRoot)
$node = Join-Path $root 'runtime\node.exe'
$cli = Join-Path $root 'app\bin\cli.mjs'
$git = Join-Path $root 'resources\git\cmd\git.exe'
$assets = Join-Path $root 'resources\busytex'
$browsers = Join-Path $root 'resources\playwright'

Require-File $node 'Bundled Node runtime'
Require-File $cli 'Packaged TeXChronicle CLI'
Require-File $git 'Bundled Git runtime'
Require-File (Join-Path $assets 'busytex.wasm') 'Bundled BusyTeX engine'
Require-Directory $browsers 'Bundled Playwright browsers'
if (-not @(Get-ChildItem -LiteralPath $browsers -Directory -Filter 'chromium_headless_shell-*').Count) {
  throw "No bundled Playwright Chromium headless shell was found in $browsers"
}

Write-Step 'Checking bundled executables'
$nodeVersion = (& $node --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Bundled Node failed: $nodeVersion" }
$gitVersion = (& $git --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Bundled Git failed: $gitVersion" }
$help = (& $node $cli --help 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or -not $help.Contains('TeXChronicle')) {
  throw "Packaged TeXChronicle CLI failed its help check:`n$help"
}
Write-Host "  $nodeVersion"
Write-Host "  $gitVersion"

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$scratch = Join-Path $tempBase ("TeXChronicle-portable-smoke-{0}" -f [Guid]::NewGuid().ToString('N'))
$project = Join-Path $scratch 'project'
$isolatedAppData = Join-Path $scratch 'appdata'
$tex = Join-Path $project 'main.tex'
$process = $null

try {
  New-Item -ItemType Directory -Force -Path $project, $isolatedAppData | Out-Null
  $source = @'
\documentclass{article}
\begin{document}
Portable TeXChronicle smoke test.
\section{History}
This PDF and its source checkpoint must be created together.
\end{document}
'@
  [IO.File]::WriteAllText($tex, $source, (New-Object Text.UTF8Encoding($false)))

  Write-Step 'Compiling a real LaTeX project with only bundled dependencies'
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $node
  $start.Arguments = @(
    (Quote-ProcessArgument $cli),
    'preview',
    (Quote-ProcessArgument $tex),
    '--backend', 'wasm',
    '--no-open',
    '--desktop',
    '--exit-after-initial-compile'
  ) -join ' '
  $start.WorkingDirectory = $project
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.Encoding]::UTF8
  $start.StandardErrorEncoding = [Text.Encoding]::UTF8
  $start.EnvironmentVariables['TEXCHRONICLE_PORTABLE_ROOT'] = $root
  $start.EnvironmentVariables['TEXCHRONICLE_ASSETS_DIR'] = $assets
  $start.EnvironmentVariables['PLAYWRIGHT_BROWSERS_PATH'] = $browsers
  $start.EnvironmentVariables['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = '1'
  $start.EnvironmentVariables['PLAYWRIGHT_SKIP_BROWSER_GC'] = '1'
  $start.EnvironmentVariables['APPDATA'] = $isolatedAppData
  $start.EnvironmentVariables['PATH'] = (Join-Path $root 'resources\git\cmd') + ';' + (Join-Path $root 'runtime') + ';' + $start.EnvironmentVariables['PATH']

  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'The packaged TeXChronicle process did not start.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
    throw "Portable compile timed out after $TimeoutSeconds seconds."
  }
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0 -or -not $stdout.Contains('[TeXChronicle] PORTABLE_SELF_TEST_OK')) {
    throw "Portable compile failed (exit $($process.ExitCode)).`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
  }

  Write-Step 'Verifying the Git checkpoint and its exact rendered PDF'
  $historyDir = Join-Path $project '.latex-preview\history.git'
  Require-File (Join-Path $historyDir 'HEAD') 'Shadow history repository'
  $oldGitDir = $env:GIT_DIR
  $oldGitWorkTree = $env:GIT_WORK_TREE
  try {
    $env:GIT_DIR = $historyDir
    $env:GIT_WORK_TREE = $project
    $sha = (& $git rev-parse --verify refs/latex-preview/successful 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40,64}$') {
      throw "No successful portable checkpoint was created: $sha"
    }
  } finally {
    $env:GIT_DIR = $oldGitDir
    $env:GIT_WORK_TREE = $oldGitWorkTree
  }

  $render = Join-Path $project ".latex-preview\renders\$sha.pdf"
  Require-File $render 'Checkpoint render artifact'
  $prefix = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($render), 0, 5)
  if ($prefix -ne '%PDF-') { throw "The checkpoint artifact is not a PDF: $render" }

  Write-Host "[portable verify] PASS - compile, checkpoint, and PDF artifact $($sha.Substring(0, 10))" -ForegroundColor Green
} finally {
  if ($process -and -not $process.HasExited) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
  }
  if (-not $KeepSmokeProject -and (Test-Path -LiteralPath $scratch)) {
    $fullScratch = [IO.Path]::GetFullPath($scratch)
    $safePrefix = $tempBase.TrimEnd('\') + '\'
    if (-not $fullScratch.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a smoke-test path outside the temp directory: $fullScratch"
    }
    Remove-Item -LiteralPath $fullScratch -Recurse -Force
  }
}
