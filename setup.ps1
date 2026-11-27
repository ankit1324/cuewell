<#
.SYNOPSIS
  Set up Cuewell on Windows: check Node.js, create .env, install Node
  dependencies, fetch the built-in voice engine, then start the app.

.DESCRIPTION
  The Windows counterpart of setup.sh. Run it from the project folder:

    powershell -ExecutionPolicy Bypass -File .\setup.ps1

  Steps:
    1. Check that Node.js 22.12 or newer and npm are installed.
    2. Create .env from env.example if it does not exist.
    3. Install Node dependencies (npm install, or npm ci with -Ci).
    4. Fetch the built-in local voice engine (whisper.cpp) into
       vendor\whisper with npm run fetch:whisper. It needs no Python. Skip
       with -SkipWhisper. The speech model (Small 190 MB or Base 60 MB)
       downloads once from the Cuewell setup wizard or Settings > Voice.
       Advanced: -PythonWhisper installs the Python openai-whisper engine
       into .venv-whisper instead (Python 3.10 or newer, 3.12 preferred,
       found through the py launcher; 3 to 5 GB of disk).
    5. Optionally build the Windows installer (-Build).
    6. Start Cuewell (skip with -NoRun).

  If the GEMINI_API_KEY environment variable is set, it is written to .env.

.EXAMPLE
  .\setup.ps1
.EXAMPLE
  .\setup.ps1 -SkipWhisper -NoRun
.EXAMPLE
  .\setup.ps1 -Build -NoRun
.EXAMPLE
  .\setup.ps1 -PythonWhisper
#>
[CmdletBinding()]
param(
  # Build the Windows installer and portable app into dist\ after setup.
  [switch]$Build,
  # Do not start the app after setup.
  [switch]$NoRun,
  # Use 'npm ci' instead of 'npm install'.
  [switch]$Ci,
  # Skip the local voice engine setup.
  [switch]$SkipWhisper,
  # Advanced: install the Python openai-whisper engine instead of whisper.cpp.
  [switch]$PythonWhisper,
  # Show help and exit.
  [switch]$Help
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Keep in sync with setup.sh and src/core/whisper-installer.js.
$MinNodeMajor = 22
$MinNodeMinor = 12
$WhisperPipSpec = 'openai-whisper==20250625'
$WhisperVenvDir = '.venv-whisper'
$WhisperModelDir = '.whisper-models'
$WhisperModel = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { 'base' }
$WhisperLanguage = if ($env:WHISPER_LANGUAGE) { $env:WHISPER_LANGUAGE } else { 'en' }
$WhisperSegmentMs = if ($env:WHISPER_SEGMENT_MS) { $env:WHISPER_SEGMENT_MS } else { '4000' }
# Python versions to try through the py launcher, most preferred first.
$PreferredPythonVersions = @('3.12', '3.11', '3.10', '3.13')

# Windows PowerShell 5.1 has no $IsWindows; it only runs on Windows.
$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ((Test-Path variable:IsWindows) -and $IsWindows)
# npm.cmd avoids npm.ps1, which a restrictive execution policy can block.
$Npm = if ($OnWindows) { 'npm.cmd' } else { 'npm' }

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "Warning: $Message" -ForegroundColor Yellow }
function Fail([string]$Message) {
  Write-Host "Error: $Message" -ForegroundColor Red
  exit 1
}

if ($Help) {
  Get-Help -Detailed $PSCommandPath
  exit 0
}

# Run a native command, hide its output, and return its exit code and output.
# Windows PowerShell 5.1 turns redirected stderr into errors, which would stop
# the script under ErrorActionPreference=Stop, so relax it here.
function Invoke-Native {
  param([string]$Command, [string[]]$Arguments = @())
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Command @Arguments 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Output = $output.Trim() }
  } catch {
    return @{ Code = -1; Output = $_.Exception.Message }
  } finally {
    $ErrorActionPreference = $previous
  }
}

# Run a native command with its output shown; fail with $Message on error.
function Invoke-Checked {
  param([string]$Command, [string[]]$Arguments = @(), [string]$Message)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command @Arguments
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) { Fail "$Message (exit code $code)" }
}

# Run a script block without API keys, tokens or secrets in the environment,
# so downloads, pip, Python and Whisper never see them. They are restored afterwards.
# Returns the block's output.
function Invoke-WithoutSecrets([scriptblock]$Block) {
  $saved = @{}
  foreach ($item in @(Get-ChildItem Env:)) {
    if ($item.Name -match '(_KEY|_TOKEN|_SECRET)$' -or $item.Name -like 'AZURE_SPEECH_KEY*') {
      $saved[$item.Name] = $item.Value
      Remove-Item -LiteralPath "Env:$($item.Name)"
    }
  }
  try {
    & $Block
  } finally {
    foreach ($name in $saved.Keys) { Set-Item -LiteralPath "Env:$name" -Value $saved[$name] }
  }
}

# Limit .env to the current user (the Windows equivalent of chmod 600):
# remove inherited permissions and grant only this account full control.
function Protect-EnvFile([string]$Path) {
  if (-not $OnWindows) { return }
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } catch {
    Write-Warn "Could not limit .env to your account: $($_.Exception.Message)"
  }
}

# Set KEY=value in .env: replace the first KEY= line or append one. The file is
# written as UTF-8 without a byte order mark (dotenv would read a BOM as part
# of the first key) through a temporary file, so a failure never leaves a
# half-written .env.
function Set-EnvValue([string]$Key, [string]$Value) {
  if ($Value -match "[`r`n]") { Fail "Refusing to write a multi-line value for $Key to .env." }
  $path = Join-Path (Get-Location) '.env'
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath $path) {
    foreach ($line in [System.IO.File]::ReadAllLines($path)) { $lines.Add($line) }
  }
  $prefix = "$Key="
  $done = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].StartsWith($prefix, [System.StringComparison]::Ordinal)) {
      $lines[$i] = $prefix + $Value
      $done = $true
      break
    }
  }
  if (-not $done) { $lines.Add($prefix + $Value) }
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllLines($tmp, $lines.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $path -Force
  Protect-EnvFile $path
}

function Get-EnvValue([string]$Key) {
  $path = Join-Path (Get-Location) '.env'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  foreach ($line in [System.IO.File]::ReadAllLines($path)) {
    if ($line.StartsWith("$Key=", [System.StringComparison]::Ordinal)) { return $line.Substring($Key.Length + 1) }
  }
  return $null
}

function Test-NodeVersion {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js $MinNodeMajor.$MinNodeMinor or newer is required. Install it from https://nodejs.org/ and run this script again."
  }
  if (-not (Get-Command $Npm -ErrorAction SilentlyContinue)) {
    Fail 'npm was not found. Reinstall Node.js from https://nodejs.org/ and run this script again.'
  }
  $result = Invoke-Native 'node' @('-p', 'process.versions.node')
  if ($result.Code -ne 0 -or $result.Output -notmatch '^(\d+)\.(\d+)') {
    Fail "Could not read the Node.js version: $($result.Output)"
  }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -lt $MinNodeMajor -or ($major -eq $MinNodeMajor -and $minor -lt $MinNodeMinor)) {
    Fail "Node.js $MinNodeMajor.$MinNodeMinor or newer is required (found $($result.Output)). Install a newer version from https://nodejs.org/ and run this script again."
  }
  Write-Host "Node: v$($result.Output)"
  $npmVersion = Invoke-Native $Npm @('-v')
  Write-Host "npm:  $($npmVersion.Output)"
}

function Initialize-EnvFile {
  if (-not (Test-Path -LiteralPath '.env')) {
    if (-not (Test-Path -LiteralPath 'env.example')) { Fail 'env.example is missing from the project folder.' }
    Write-Step 'Creating .env from env.example'
    Copy-Item -LiteralPath 'env.example' -Destination '.env'
  }
  Protect-EnvFile (Join-Path (Get-Location) '.env')

  if ($env:GEMINI_API_KEY) {
    Set-EnvValue 'GEMINI_API_KEY' $env:GEMINI_API_KEY
    # The app reads it from .env; keep it out of npm and pip.
    Remove-Item -LiteralPath 'Env:GEMINI_API_KEY'
    Write-Host 'Saved GEMINI_API_KEY to .env.'
  }

  $key = Get-EnvValue 'GEMINI_API_KEY'
  if (-not $key -or $key -eq 'your_gemini_api_key_here') {
    Write-Host ''
    Write-Host 'No AI provider key is set yet. Cuewell will open its setup wizard on first'
    Write-Host 'launch so you can choose a provider and enter a key.'
    Write-Host ''
  }
}

function Install-NodeDependencies {
  if ($Ci -and (Test-Path -LiteralPath 'package-lock.json')) {
    Write-Step 'Installing Node dependencies (npm ci)'
    Invoke-Checked $Npm @('ci') 'npm ci failed'
  } else {
    Write-Step 'Installing Node dependencies (npm install)'
    Invoke-Checked $Npm @('install') 'npm install failed'
  }
}

# The first Python 3.10+ found, as @{ Command; Arguments; Version }, or $null.
function Find-Python {
  $versionScript = 'import sys; print(*sys.version_info[:2], sep=chr(46))'
  $candidates = New-Object System.Collections.Generic.List[object]
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($v in $PreferredPythonVersions) { $candidates.Add(@{ Command = 'py'; Arguments = @("-$v") }) }
    $candidates.Add(@{ Command = 'py'; Arguments = @('-3') })
  }
  # Paths under WindowsApps go last. That folder holds real app execution
  # aliases (python.org install manager, Microsoft Store Python) and also the
  # Store "python" stub, which fails the version check below and is skipped.
  foreach ($name in @('python', 'python3')) {
    $found = @(Get-Command $name -CommandType Application -ErrorAction SilentlyContinue)
    foreach ($cmd in @($found | Where-Object { $_.Source -notmatch '\\WindowsApps\\' }) + @($found | Where-Object { $_.Source -match '\\WindowsApps\\' })) {
      $candidates.Add(@{ Command = $cmd.Source; Arguments = @() })
    }
  }
  foreach ($candidate in $candidates) {
    $result = Invoke-Native $candidate.Command ($candidate.Arguments + @('-c', $versionScript))
    if ($result.Code -ne 0 -or $result.Output -notmatch '^(\d+)\.(\d+)$') { continue }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 10)) {
      $candidate.Version = $result.Output
      return $candidate
    }
  }
  return $null
}

# Clear the env.example Azure placeholders, but never a real Azure key.
function Clear-AzurePlaceholders {
  if ((Get-EnvValue 'AZURE_SPEECH_KEY') -eq 'your_azure_speech_key_here') { Set-EnvValue 'AZURE_SPEECH_KEY' '' }
  if ((Get-EnvValue 'AZURE_SPEECH_REGION') -eq 'your_azure_region_here') { Set-EnvValue 'AZURE_SPEECH_REGION' '' }
}

# Fetch the pinned whisper.cpp whisper-server for this machine into
# vendor\whisper\<platform>-<arch> with the project's own script. It skips the
# work when a valid binary is already there. A failure only disables local
# voice; setup carries on.
function Initialize-WhisperCpp {
  # No double quotes in the script: Windows PowerShell 5.1 strips them from
  # native command arguments.
  $hasScript = Invoke-Native 'node' @('-e', 'const s = require(''./package.json'').scripts || {}; process.exit(s[''fetch:whisper''] ? 0 : 1)')
  if ($hasScript.Code -ne 0) {
    Write-Warn "This checkout has no 'npm run fetch:whisper' script, so the built-in voice engine was not set up."
    Write-Host 'Update the repository and run this script again.'
    return
  }

  Write-Step 'Setting up the built-in voice engine (whisper.cpp)'
  $fetchCode = Invoke-WithoutSecrets {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      # Out-Host shows the download progress live instead of returning it.
      & $Npm run fetch:whisper | Out-Host
      $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
  }
  if ($fetchCode -ne 0) {
    Write-Warn 'The built-in voice engine could not be set up, so local voice is off.'
    Write-Host 'Check your network connection. Only 64-bit (x64) Windows is supported.'
    Write-Host 'Then run this script again, or use Azure Speech in Settings > Voice.'
    return
  }
  Clear-AzurePlaceholders
  Write-Host 'The built-in voice engine is ready.'
  Write-Host 'Cuewell downloads a speech model once (Small 190 MB or Base 60 MB) from the setup wizard or Settings > Voice.'
}

function Initialize-Voice {
  if ($SkipWhisper) {
    Write-Host 'Skipping local voice setup.'
    return
  }
  if ($Build -and $NoRun) {
    # The build scripts fetch the engine they bundle.
    Write-Host 'Skipping local voice setup (build only).'
    return
  }
  if ($PythonWhisper) {
    Initialize-PythonWhisper
  } else {
    Initialize-WhisperCpp
  }
}

# Advanced (-PythonWhisper): install openai-whisper into a Python venv.
function Initialize-PythonWhisper {
  Write-Step 'Setting up Python Whisper'
  $venvPython = Join-Path $WhisperVenvDir 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPython)) {
    $python = Find-Python
    if (-not $python) {
      Write-Warn 'Python 3.10 or newer was not found, so local Whisper was not set up.'
      Write-Host 'Install Python 3.12 from https://www.python.org/downloads/ (turn on "Add python.exe to PATH"),'
      Write-Host 'or run: winget install Python.Python.3.12'
      Write-Host 'Then run this script with -PythonWhisper again, or run it without -PythonWhisper'
      Write-Host 'to use the built-in engine, which needs no Python.'
      return
    }
    Write-Host "Using Python $($python.Version): $($python.Command) $($python.Arguments -join ' ')"
    Write-Host "Creating the Whisper virtual environment in $WhisperVenvDir"
    $result = Invoke-WithoutSecrets { Invoke-Native $python.Command ($python.Arguments + @('-m', 'venv', $WhisperVenvDir)) }
    if ($result.Code -ne 0) { Write-Warn "Could not create the virtual environment: $($result.Output)" }
    if ($result.Code -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
      Write-Warn "Local Whisper was not set up. Delete the $WhisperVenvDir folder if it exists and run this script again."
      return
    }
  }

  Write-Host "Installing $WhisperPipSpec (this downloads about 1 GB and can take several minutes)"
  $pipCode = Invoke-WithoutSecrets {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      # Out-Host shows pip's progress live instead of returning it.
      & $venvPython -m pip install --upgrade pip | Out-Host
      & $venvPython -m pip install $WhisperPipSpec | Out-Host
      $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
  }
  if ($pipCode -ne 0) {
    Write-Warn "pip install $WhisperPipSpec failed, so Whisper may be unavailable."
    Write-Host 'Common causes: not enough disk space (Whisper needs 3 to 5 GB), no network, or an unsupported Python version.'
    return
  }

  $check = Invoke-WithoutSecrets { Invoke-Native $venvPython @('-c', 'import whisper') }
  if ($check.Code -ne 0) {
    Write-Warn "Whisper was installed but does not load: $($check.Output)"
    return
  }

  New-Item -ItemType Directory -Force -Path $WhisperModelDir | Out-Null

  # A relative path, like setup.sh writes: the app resolves it against the
  # project folder, and it avoids quoting problems with spaces in user names.
  Set-EnvValue 'SPEECH_PROVIDER' 'whisper'
  Set-EnvValue 'WHISPER_ENGINE' 'python'
  Set-EnvValue 'WHISPER_COMMAND' "$WhisperVenvDir\Scripts\python.exe -m whisper"
  Set-EnvValue 'WHISPER_MODEL_DIR' $WhisperModelDir
  Set-EnvValue 'WHISPER_MODEL' $WhisperModel
  Set-EnvValue 'WHISPER_LANGUAGE' $WhisperLanguage
  Set-EnvValue 'WHISPER_SEGMENT_MS' $WhisperSegmentMs
  Clear-AzurePlaceholders
  Write-Host 'Python Whisper is set up.'

  Write-Step 'Running the speech test'
  Invoke-WithoutSecrets {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $Npm run test-speech | Out-Host
      if ($LASTEXITCODE -ne 0) { Write-Warn 'The speech test failed. See the output above.' }
    } finally {
      $ErrorActionPreference = $previous
    }
  }
}

Write-Host '========================================'
Write-Host ' Cuewell Setup (Windows)'
Write-Host '========================================'

Push-Location -LiteralPath $PSScriptRoot
try {
  Test-NodeVersion
  Initialize-EnvFile
  Install-NodeDependencies
  Initialize-Voice

  if ($Build) {
    Write-Step 'Building the Windows installer and portable app (npm run build:win)'
    Invoke-Checked $Npm @('run', 'build:win') 'The build failed'
    Write-Host 'Build output is in the dist folder.'
  }

  if ($NoRun) {
    Write-Host 'Setup complete. Start Cuewell with: npm start'
  } else {
    Write-Step 'Starting Cuewell'
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $Npm start
      # 130 and 0xC000013A (-1073741510) mean the app was closed with Ctrl+C.
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 130 -and $LASTEXITCODE -ne -1073741510) {
        Write-Warn "Cuewell exited with code $LASTEXITCODE. Logs are in $env:USERPROFILE\.Cuewell\logs."
      }
    } finally {
      $ErrorActionPreference = $previous
    }
  }
} finally {
  Pop-Location
}
