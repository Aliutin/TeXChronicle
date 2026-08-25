[CmdletBinding()]
param(
  [string] $OutputDirectory = '',
  [string] $BusyTeXDirectory = '',
  [string] $PlaywrightDirectory = '',
  [string] $NodeArchive = '',
  [string] $GitArchive = '',
  [switch] $SkipUiBuild,
  [switch] $SkipArchive,
  [switch] $SkipSmokeTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string] $Message) {
  Write-Host "`n[portable build] $Message" -ForegroundColor Cyan
}

function Require-File([string] $Path, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
}

function Require-Directory([string] $Path, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label is missing: $Path" }
}

function Invoke-Checked([string] $FilePath, [string[]] $Arguments, [string] $WorkingDirectory = '') {
  if ($WorkingDirectory) { Push-Location -LiteralPath $WorkingDirectory }
  try {
    & $FilePath @Arguments
    $code = $LASTEXITCODE
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0) { throw "Command failed with exit code ${code}: $FilePath $($Arguments -join ' ')" }
}

function Copy-Tree([string] $Source, [string] $Destination) {
  Require-Directory $Source 'Copy source'
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & (Join-Path $env:SystemRoot 'System32\robocopy.exe') $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Host
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "robocopy failed with exit code $code while copying $Source" }
}

function Download-File([string] $Url, [string] $Destination) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    Write-Host "  reusing $(Split-Path -Leaf $Destination)"
    return
  }
  Write-Host "  downloading $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Get-Sha256([string] $Path) {
  Require-File $Path 'Hash input'
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist-portable' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$stageName = 'TeXChronicle-Portable-Windows-x64'
$stage = Join-Path $outputRoot $stageName
$work = Join-Path $outputRoot '.work'
$cache = Join-Path $outputRoot '.cache'

function Assert-BuildChild([string] $Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $prefix = $outputRoot.TrimEnd('\') + '\'
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a build operation outside the selected output directory: $full"
  }
}

function Remove-BuildChildWithRetry([string] $Path, [switch] $BestEffort) {
  Assert-BuildChild $Path
  if (-not (Test-Path -LiteralPath $Path)) { return }

  $lastError = $null
  foreach ($attempt in 1..12) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      if (-not (Test-Path -LiteralPath $Path)) { return }
    } catch {
      $lastError = $_
    }
    Start-Sleep -Milliseconds 500
  }

  $message = "Could not remove build path after retrying: $Path"
  if ($lastError) { $message += " ($($lastError.Exception.Message))" }
  if ($BestEffort) {
    Write-Warning $message
    return
  }
  throw $message
}

function Reset-BuildChild([string] $Path) {
  Remove-BuildChildWithRetry $Path
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

New-Item -ItemType Directory -Force -Path $outputRoot, $cache | Out-Null
Reset-BuildChild $stage
Reset-BuildChild $work
$oldNpmCache = $env:npm_config_cache
$env:npm_config_cache = Join-Path $cache 'npm'

try {
  $nodeHost = (Get-Command node.exe -ErrorAction Stop).Source
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  Require-File $tar 'Windows archive tool'

  $builtUi = $null
  if (-not $SkipUiBuild) {
    Write-Step 'Building the browser workspace in an isolated staging directory'
    $builtUi = Join-Path $work 'ui-dist'
    Invoke-Checked $nodeHost @(
      (Join-Path $repoRoot 'node_modules\vite\bin\vite.js'),
      'build', (Join-Path $repoRoot 'ui'),
      '--outDir', $builtUi,
      '--emptyOutDir'
    ) $repoRoot
  } else {
    Require-File (Join-Path $repoRoot 'ui\dist\index.html') 'Prebuilt browser workspace'
  }

  Write-Step 'Packing the application and production dependencies'
  $packDir = Join-Path $work 'pack'
  $extractDir = Join-Path $work 'extract'
  New-Item -ItemType Directory -Force -Path $packDir, $extractDir | Out-Null
  Invoke-Checked $npm @('pack', '--pack-destination', $packDir) $repoRoot
  $archive = Get-ChildItem -LiteralPath $packDir -Filter '*.tgz' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $archive) { throw 'npm pack did not create an application archive.' }
  Invoke-Checked $tar @('-xf', $archive.FullName, '-C', $extractDir)
  $packedApp = Join-Path $extractDir 'package'
  Require-File (Join-Path $packedApp 'bin\cli.mjs') 'Packed CLI'
  # Copy instead of moving: Dropbox, antivirus, or indexing can briefly hold a
  # freshly extracted directory and make Move-Item fail while removing its source.
  Copy-Tree $packedApp (Join-Path $stage 'app')
  if ($builtUi) {
    $packagedUi = Join-Path $stage 'app\ui\dist'
    if (Test-Path -LiteralPath $packagedUi) { Remove-Item -LiteralPath $packagedUi -Recurse -Force }
    Copy-Tree $builtUi $packagedUi
  }
  Copy-Item -LiteralPath (Join-Path $repoRoot 'package-lock.json') -Destination (Join-Path $stage 'app\package-lock.json')
  Invoke-Checked $npm @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') (Join-Path $stage 'app')

  Write-Step 'Bundling and verifying Node.js'
  $hostNodeVersion = (& $nodeHost -p 'process.versions.node' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $hostNodeVersion) { throw 'Could not determine the build-time Node version.' }
  $nodeArchiveName = "node-v$hostNodeVersion-win-x64.zip"
  if ($NodeArchive) {
    $nodeZip = [IO.Path]::GetFullPath($NodeArchive)
  } else {
    $nodeZip = Join-Path $cache $nodeArchiveName
    $nodeBase = "https://nodejs.org/dist/v$hostNodeVersion"
    Download-File "$nodeBase/$nodeArchiveName" $nodeZip
    $sums = Join-Path $cache "node-v$hostNodeVersion-SHASUMS256.txt"
    Download-File "$nodeBase/SHASUMS256.txt" $sums
    $escapedName = [Regex]::Escape($nodeArchiveName)
    $sumLine = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match "\s+\*?$escapedName$" }) | Select-Object -First 1
    if (-not $sumLine) { throw "No official SHA-256 entry was found for $nodeArchiveName" }
    $expected = ($sumLine.Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = Get-Sha256 $nodeZip
    if ($actual -ne $expected) { throw "Node archive SHA-256 mismatch: expected $expected, got $actual" }
  }
  Require-File $nodeZip 'Node archive'
  $nodeExtract = Join-Path $work 'node'
  New-Item -ItemType Directory -Force -Path $nodeExtract | Out-Null
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
  $nodeFolder = Get-ChildItem -LiteralPath $nodeExtract -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
  if (-not $nodeFolder) { throw "The Node archive did not contain node.exe: $nodeZip" }
  $runtimeDir = Join-Path $stage 'runtime'
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $nodeFolder.FullName 'node.exe') -Destination $runtimeDir
  Copy-Item -LiteralPath (Join-Path $nodeFolder.FullName 'LICENSE') -Destination (Join-Path $runtimeDir 'NODE-LICENSE.txt')
  $portableNode = Join-Path $runtimeDir 'node.exe'
  $portableNodeVersion = (& $portableNode -p 'process.versions.node' | Out-String).Trim()

  Write-Step 'Bundling the Playwright browser engine'
  if (-not $PlaywrightDirectory) {
    if ($env:PLAYWRIGHT_BROWSERS_PATH -and $env:PLAYWRIGHT_BROWSERS_PATH -ne '0') {
      $PlaywrightDirectory = $env:PLAYWRIGHT_BROWSERS_PATH
    } else {
      $PlaywrightDirectory = Join-Path $env:LOCALAPPDATA 'ms-playwright'
    }
  }
  $PlaywrightDirectory = [IO.Path]::GetFullPath($PlaywrightDirectory)
  $headless = @(Get-ChildItem -LiteralPath $PlaywrightDirectory -Directory -Filter 'chromium_headless_shell-*' -ErrorAction SilentlyContinue)
  if (-not $headless.Count) {
    $PlaywrightDirectory = Join-Path $cache 'playwright'
    New-Item -ItemType Directory -Force -Path $PlaywrightDirectory | Out-Null
    $oldPwPath = $env:PLAYWRIGHT_BROWSERS_PATH
    try {
      $env:PLAYWRIGHT_BROWSERS_PATH = $PlaywrightDirectory
      Invoke-Checked $portableNode @((Join-Path $stage 'app\node_modules\playwright\cli.js'), 'install', 'chromium', '--only-shell')
    } finally {
      $env:PLAYWRIGHT_BROWSERS_PATH = $oldPwPath
    }
    $headless = @(Get-ChildItem -LiteralPath $PlaywrightDirectory -Directory -Filter 'chromium_headless_shell-*' -ErrorAction SilentlyContinue)
  }
  if (-not $headless.Count) { throw "Playwright did not provide a Chromium headless shell in $PlaywrightDirectory" }
  $browserDest = Join-Path $stage 'resources\playwright'
  New-Item -ItemType Directory -Force -Path $browserDest | Out-Null
  $browserDirs = @(
    Get-ChildItem -LiteralPath $PlaywrightDirectory -Directory | Where-Object {
      $_.Name -like 'chromium_headless_shell-*' -or $_.Name -like 'ffmpeg-*' -or $_.Name -like 'winldd-*'
    }
  )
  foreach ($directory in $browserDirs) {
    Copy-Tree $directory.FullName (Join-Path $browserDest $directory.Name)
  }

  Write-Step 'Bundling the offline BusyTeX/TeX Live assets'
  if (-not $BusyTeXDirectory) {
    if ($env:TEXCHRONICLE_ASSETS_DIR) {
      $BusyTeXDirectory = $env:TEXCHRONICLE_ASSETS_DIR
    } elseif ($env:MAGICTEX_ASSETS_DIR) {
      # Migration alias for an engine cache configured before the rename.
      $BusyTeXDirectory = $env:MAGICTEX_ASSETS_DIR
    } else {
      $newBusyTeX = Join-Path $env:LOCALAPPDATA 'texchronicle\busytex'
      $legacyBusyTeX = Join-Path $env:LOCALAPPDATA 'magictex\busytex'
      $BusyTeXDirectory = if (Test-Path -LiteralPath (Join-Path $newBusyTeX 'busytex.wasm')) { $newBusyTeX } elseif (Test-Path -LiteralPath (Join-Path $legacyBusyTeX 'busytex.wasm')) { $legacyBusyTeX } else { $newBusyTeX }
    }
  }
  $BusyTeXDirectory = [IO.Path]::GetFullPath($BusyTeXDirectory)
  if (-not (Test-Path -LiteralPath (Join-Path $BusyTeXDirectory 'busytex.wasm') -PathType Leaf)) {
    $busyParent = Join-Path $cache 'busytex-assets'
    New-Item -ItemType Directory -Force -Path $busyParent | Out-Null
    Invoke-Checked $portableNode @((Join-Path $stage 'app\node_modules\texlyre-busytex\scripts\cli.cjs'), 'download-assets', $busyParent)
    $BusyTeXDirectory = Join-Path $busyParent 'busytex'
  }
  Require-File (Join-Path $BusyTeXDirectory 'busytex.wasm') 'BusyTeX WASM engine'
  $busyDest = Join-Path $stage 'resources\busytex'
  Copy-Tree $BusyTeXDirectory $busyDest

  Write-Step 'Bundling portable Git for project history'
  $gitAssetName = $null
  $gitDigest = $null
  if ($GitArchive) {
    $gitZip = [IO.Path]::GetFullPath($GitArchive)
    $gitAssetName = Split-Path -Leaf $gitZip
  } else {
    $headers = @{ 'User-Agent' = 'TeXChronicle-portable-builder' }
    try {
      $release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest'
      $asset = @($release.assets | Where-Object { $_.name -match '^MinGit-(?!.*busybox).*64-bit\.zip$' }) | Select-Object -First 1
      if (-not $asset) { throw 'The latest Git for Windows release has no 64-bit MinGit archive.' }
      $gitAssetName = [string] $asset.name
      $gitDigest = if ($asset.PSObject.Properties.Name -contains 'digest') { [string] $asset.digest } else { $null }
      $gitZip = Join-Path $cache $gitAssetName
      Download-File ([string] $asset.browser_download_url) $gitZip
    } catch {
      $cachedGit = Get-ChildItem -LiteralPath $cache -Filter 'MinGit-*-64-bit.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if (-not $cachedGit) { throw }
      Write-Warning "GitHub release lookup failed; reusing cached $($cachedGit.Name): $($_.Exception.Message)"
      $gitZip = $cachedGit.FullName
      $gitAssetName = $cachedGit.Name
    }
  }
  Require-File $gitZip 'MinGit archive'
  if ($gitDigest -and $gitDigest -match '^sha256:([0-9a-fA-F]{64})$') {
    $actualGitDigest = Get-Sha256 $gitZip
    if ($actualGitDigest -ne $Matches[1].ToLowerInvariant()) { throw "MinGit archive SHA-256 mismatch: expected $($Matches[1]), got $actualGitDigest" }
  }
  $gitDest = Join-Path $stage 'resources\git'
  New-Item -ItemType Directory -Force -Path $gitDest | Out-Null
  Expand-Archive -LiteralPath $gitZip -DestinationPath $gitDest -Force
  $portableGit = Join-Path $gitDest 'cmd\git.exe'
  Require-File $portableGit 'Portable Git executable'
  $portableGitVersion = (& $portableGit --version | Out-String).Trim()

  Write-Step 'Compiling the native, console-free launcher'
  $cscCandidates = @(
    (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  $csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $csc) { throw 'The Windows .NET Framework C# compiler was not found.' }
  $launcherSource = Join-Path $PSScriptRoot 'TeXChronicle.Launcher.cs'
  $launcherManifest = Join-Path $PSScriptRoot 'TeXChronicle.Launcher.manifest'
  Require-File $launcherSource 'Launcher source'
  Require-File $launcherManifest 'Launcher manifest'
  $launcher = Join-Path $stage 'TeXChronicle.exe'
  Invoke-Checked $csc @(
    '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    "/win32manifest:$launcherManifest", "/out:$launcher", $launcherSource
  )
  Require-File $launcher 'Portable launcher'

  Write-Step 'Writing licenses, instructions, and the reproducibility manifest'
  Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot 'NOTICE.md') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\PORTABLE-WINDOWS.md') -Destination (Join-Path $stage 'README-PORTABLE.txt')
  $package = Get-Content -Raw -LiteralPath (Join-Path $stage 'app\package.json') | ConvertFrom-Json
  $commit = (& $portableGit -C $repoRoot rev-parse HEAD 2>$null | Out-String).Trim()
  $dirty = [bool]((& $portableGit -C $repoRoot status --porcelain 2>$null | Out-String).Trim())
  $busyBytes = (Get-ChildItem -LiteralPath $busyDest -File -Recurse | Measure-Object -Property Length -Sum).Sum
  $manifest = [ordered]@{
    product = 'TeXChronicle Portable for Windows x64'
    appVersion = [string] $package.version
    builtAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    sourceCommit = $commit
    sourceTreeDirty = $dirty
    node = $portableNodeVersion
    git = $portableGitVersion
    minGitArchive = $gitAssetName
    busyTeXVersion = [string] $package.dependencies.'texlyre-busytex'
    busyTeXBytes = [long] $busyBytes
    playwrightVersion = [string] $package.dependencies.playwright
    playwrightPayloads = @($browserDirs | ForEach-Object { $_.Name })
    launcherSha256 = Get-Sha256 $launcher
    offlineRuntime = $true
  }
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $stage 'PORTABLE-MANIFEST.json'), ($manifest | ConvertTo-Json -Depth 5) + "`n", $utf8)

  if (-not $SkipSmokeTest) {
    Write-Step 'Running the packaged offline compile/history smoke test'
    & (Join-Path $PSScriptRoot 'verify-portable.ps1') -PackageRoot $stage
  }

  $archiveBase = "TeXChronicle-$($package.version)-Portable-Windows-x64"
  $zip = Join-Path $outputRoot "$archiveBase.zip"
  $shaFile = "$zip.sha256"
  if (-not $SkipArchive) {
    Write-Step 'Creating the shareable ZIP'
    foreach ($path in @($zip, $shaFile)) {
      Assert-BuildChild $path
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    Invoke-Checked $tar @('-a', '-cf', $zip, '-C', $outputRoot, $stageName)
    $zipHash = Get-Sha256 $zip
    [IO.File]::WriteAllText($shaFile, "$zipHash  $(Split-Path -Leaf $zip)`n", $utf8)
  }

  $stageBytes = (Get-ChildItem -LiteralPath $stage -File -Recurse | Measure-Object -Property Length -Sum).Sum
  Write-Host "`n[portable build] PASS" -ForegroundColor Green
  Write-Host ("  folder: {0} ({1:N1} MiB)" -f $stage, ($stageBytes / 1MB))
  if (-not $SkipArchive) {
    Write-Host ("  archive: {0} ({1:N1} MiB)" -f $zip, ((Get-Item -LiteralPath $zip).Length / 1MB))
    Write-Host "  checksum: $shaFile"
  }
} finally {
  $env:npm_config_cache = $oldNpmCache
  if (Test-Path -LiteralPath $work) {
    Remove-BuildChildWithRetry $work -BestEffort
  }
}
