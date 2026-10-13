#Requires -Version 5.1
# Builds the Marteloio Windows installer: packaging\dist\Marteloio-Setup.exe
#
# Easiest: double-click packaging\build-installer.cmd. Or, in PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build-installer.ps1
#
# Steps: read VERSION; get Python's official embeddable package (downloaded once into
# packaging\cache\ and checked against the SHA-256 pinned below); copy the files listed in
# packaging\files.txt to packaging\build\app\; unpack Python into build\app\runtime\ and add
# a '..' line to its ._pth file so it can import the app; check that the bundled Python
# loads the app; compile installer.iss with Inno Setup 6; write the installer and its
# .sha256 to packaging\dist\. Every message also goes to packaging\dist\build.log.
#
# Needs Windows 10/11, Windows PowerShell 5.1 and Inno Setup 6.7.3. Writes only inside the
# packaging folder. Plain ASCII on purpose.

[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads very slow in 5.1

# ---- Pinned Python: change both lines together (see BUILDING.md) --------------------------
$PythonVersion = '3.14.8'
$PythonZipSha256 = 'a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310'
# --------------------------------------------------------------------------------------------

$PythonZipName = "python-$PythonVersion-embed-amd64.zip"
$PythonZipUrl = "https://www.python.org/ftp/python/$PythonVersion/$PythonZipName"
$PythonTag = 'python' + ($PythonVersion.Split('.')[0..1] -join '')   # python314
$PthFileName = "$PythonTag._pth"                                      # python314._pth

$PackagingDir = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PackagingDir '..')).TrimEnd('\')
$FileListPath = Join-Path $PackagingDir 'files.txt'
$IssPath = Join-Path $PackagingDir 'installer.iss'
$MarkerPath = Join-Path $PackagingDir 'marteloio-installed'
$CacheDir = Join-Path $PackagingDir 'cache'
$BuildDir = Join-Path $PackagingDir 'build'
$StageDir = Join-Path $BuildDir 'app'
$RuntimeDir = Join-Path $StageDir 'runtime'
$SelfCheckDataDir = Join-Path $BuildDir 'selfcheck-data'
$DistDir = Join-Path $PackagingDir 'dist'
$LogPath = Join-Path $DistDir 'build.log'
$SetupName = 'Marteloio-Setup.exe'
$SetupPath = Join-Path $DistDir $SetupName
$SetupShaPath = "$SetupPath.sha256"
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$Message) {
    Write-Host $Message
    if (Test-Path -LiteralPath $DistDir -PathType Container) {
        [IO.File]::AppendAllText($LogPath, $Message + "`r`n", $Utf8)
    }
}

function Assert-InPackaging([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($PackagingDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to change $full because it is outside the packaging folder."
    }
}

function Remove-Folder([string]$Path) {
    Assert-InPackaging $Path
    for ($try = 1; (Test-Path -LiteralPath $Path); $try++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force
        } catch {
            if ($try -ge 5) { throw "Couldn't delete $Path. Close any window or program using it, then run the build again." }
            Start-Sleep -Seconds 1
        }
    }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Reads packaging\files.txt: one path per line, relative to the repository root, '/' as
# separator, '#' starts a comment. Refuses anything that could pull in secrets or leave the
# repository folder.
function Read-FileList([string]$Path) {
    $entries = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    foreach ($raw in [IO.File]::ReadAllLines($Path)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line -notmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$') {
            throw "packaging\files.txt has a line that is not a plain relative path: '$line'"
        }
        $name = ($line -split '/')[-1].ToLowerInvariant()
        if ($line -match '^(tests|docs|packaging|\.github)/' -or $name -match '(\.env|\.enc|\.log|\.pem|\.key|\.pfx|\.bat|\.cmd|\.ps1|\.sh)$' -or $name -match 'secret|token') {
            throw "packaging\files.txt must not list $line (tests, docs, scripts, logs and secrets stay out of the installer)."
        }
        if ($seen.ContainsKey($line.ToLowerInvariant())) { throw "packaging\files.txt lists $line twice." }
        $seen[$line.ToLowerInvariant()] = $true
        $entries.Add($line)
    }
    if ($entries.Count -eq 0) { throw 'packaging\files.txt lists no files.' }
    return ,$entries.ToArray()
}

# Lets the embedded Python import the app: its ._pth file lists the folders on sys.path,
# relative to the runtime folder. '..' is the install folder with server.py, launch.py and
# the other modules. 'import site' stays commented out, so nothing outside the install
# folder can change how Python starts.
function Update-PthFile([string]$Path, [string]$ZipName) {
    $lines = [IO.File]::ReadAllLines($Path)
    if (-not ($lines -contains $ZipName) -or -not ($lines -contains '.')) {
        throw "$Path doesn't look like the file from python.org (no '$ZipName' and '.' lines)."
    }
    foreach ($line in $lines) {
        if ($line.Trim() -eq 'import site') { throw "$Path turns on 'import site'; expected it commented out." }
    }
    if ($lines -contains '..') { return }
    $patched = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        $patched.Add($line)
        if ($line -eq '.') { $patched.Add('..') }
    }
    [IO.File]::WriteAllText($Path, (($patched.ToArray()) -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)
}

# Runs a program, copies its output (stdout and stderr) to the console and the log, and
# returns its exit code and output lines.
function Invoke-Program([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
    Write-Log ('> ' + $FilePath + ' ' + ($Arguments -join ' '))
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # stderr lines must not stop the script in 5.1
    Push-Location -LiteralPath $WorkingDirectory
    try {
        $global:LASTEXITCODE = 0
        $output = @(& $FilePath @Arguments 2>&1)
        $code = $global:LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $saved
    }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($item in $output) {
        $text = [string]$item
        $lines.Add($text)
        Write-Log ('    ' + $text)
    }
    return New-Object PSObject -Property @{ Code = $code; Lines = $lines.ToArray() }
}

function Get-PythonZip {
    if ($PythonZipSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'The pinned SHA-256 for Python ($PythonZipSha256 near the top of this script) must be 64 lowercase hex characters. Copy it from the python.org release page.'
    }
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    $zipPath = Join-Path $CacheDir $PythonZipName
    if (Test-Path -LiteralPath $zipPath) {
        if ((Get-Sha256 $zipPath) -eq $PythonZipSha256) {
            Write-Log "Using the saved $PythonZipName (SHA-256 matches the pin)."
            return $zipPath
        }
        Write-Log "The saved $PythonZipName doesn't match the pinned SHA-256. Downloading it again."
        Remove-Item -LiteralPath $zipPath -Force
    }
    $partPath = "$zipPath.part"
    if (Test-Path -LiteralPath $partPath) { Remove-Item -LiteralPath $partPath -Force }
    Write-Log "Downloading $PythonZipUrl"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -Uri $PythonZipUrl -OutFile $partPath -UseBasicParsing
    } catch {
        if (Test-Path -LiteralPath $partPath) { Remove-Item -LiteralPath $partPath -Force }
        throw "Couldn't download $PythonZipUrl. Check the internet connection, then run the build again. ($($_.Exception.Message))"
    }
    $actual = Get-Sha256 $partPath
    if ($actual -ne $PythonZipSha256) {
        Remove-Item -LiteralPath $partPath -Force
        throw "The downloaded $PythonZipName doesn't match the pinned SHA-256 (expected $PythonZipSha256, got $actual). It was deleted and nothing was built."
    }
    Move-Item -LiteralPath $partPath -Destination $zipPath
    Write-Log "Downloaded $PythonZipName; SHA-256 matches the pin."
    return $zipPath
}

function Find-Iscc {
    $candidates = New-Object System.Collections.Generic.List[string]
    $onPath = Get-Command 'ISCC.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $candidates.Add($onPath.Path) }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if ($base) { $candidates.Add((Join-Path $base 'Inno Setup 6\ISCC.exe')) }
    }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Invoke-Build {
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    [IO.File]::WriteAllText($LogPath, '', $Utf8)
    Write-Log "Marteloio installer build, $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
    Write-Log "Repository: $RepoRoot"

    # 1. Version
    $versionPath = Join-Path $RepoRoot 'VERSION'
    if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { throw "The VERSION file is missing from $RepoRoot." }
    $version = [IO.File]::ReadAllText($versionPath).Trim()
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "VERSION must contain a version like 0.2.0, but it contains '$version'." }
    Write-Log "Version: $version"

    # 2. Python embeddable package, checked against the pinned SHA-256
    $zipPath = Get-PythonZip

    # 3. Stage the app files
    $entries = Read-FileList $FileListPath
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf) -or (Get-Item -LiteralPath $MarkerPath).Length -ne 0) {
        throw 'packaging\marteloio-installed must exist and be empty: the installer copies it into the install folder.'
    }
    Remove-Folder $BuildDir
    New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
    foreach ($entry in $entries) {
        $relative = $entry.Replace('/', '\')
        $source = Join-Path $RepoRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "packaging\files.txt lists $entry, but that file is missing from the repository folder." }
        $target = Join-Path $StageDir $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    Write-Log "Staged $($entries.Count) app files in $StageDir"

    # 4. Unpack Python into runtime\ and let it import the app
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $RuntimeDir)
    $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try { $runtimeFiles = @($zip.Entries | Where-Object { $_.Name } | ForEach-Object { 'runtime\' + $_.FullName.Replace('/', '\') }) } finally { $zip.Dispose() }
    foreach ($name in @('python.exe', 'pythonw.exe', $PthFileName)) {
        if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir $name) -PathType Leaf)) { throw "$PythonZipName has no $name." }
    }
    $pthPath = Join-Path $RuntimeDir $PthFileName
    Update-PthFile $pthPath "$PythonTag.zip"
    Write-Log "Patched runtime\$PthFileName so Python finds the app one folder up:"
    foreach ($line in [IO.File]::ReadAllLines($pthPath)) { Write-Log "    $line" }

    # 5. Self-checks with the staged runtime, run from the staged folder. -B: no __pycache__.
    #    MARTELOIO_DATA_DIR keeps anything the app might write inside packaging\build.
    New-Item -ItemType Directory -Force -Path $SelfCheckDataDir | Out-Null
    $savedDataDir = $env:MARTELOIO_DATA_DIR
    $env:MARTELOIO_DATA_DIR = $SelfCheckDataDir
    try {
        $python = Join-Path $RuntimeDir 'python.exe'
        $check = Invoke-Program $python @('-B', '-c', 'import sys; print(sys.version); print(sys.path)') $StageDir
        if ($check.Code -ne 0) { throw "The bundled Python didn't start (exit code $($check.Code))." }
        $check = Invoke-Program $python @('-B', '-c', 'import ssl, ctypes, json, http.server, pyexpat, unicodedata, server, ai_providers, app_paths') $StageDir
        if ($check.Code -ne 0) { throw "The bundled Python couldn't load Marteloio (exit code $($check.Code)). See the lines above." }
        $check = Invoke-Program $python @('-B', 'launch.py', '--version') $StageDir
        $printed = (($check.Lines | Where-Object { $_.Trim() }) | Select-Object -Last 1)
        if ($check.Code -ne 0 -or -not $printed -or $printed.Trim() -notmatch ('(^|\s)' + [regex]::Escape($version) + '$')) {
            throw "launch.py --version should print $version but printed '$printed' (exit code $($check.Code))."
        }
    } finally {
        $env:MARTELOIO_DATA_DIR = $savedDataDir
    }
    Write-Log 'Self-checks passed: the bundled Python loads the app and launch.py reports the version.'

    # 6. The staged folder must hold exactly the listed files plus Python, nothing else
    $expected = @{}
    foreach ($entry in $entries) { $expected[$entry.Replace('/', '\').ToLowerInvariant()] = $true }
    foreach ($name in $runtimeFiles) { $expected[$name.ToLowerInvariant()] = $true }
    $unexpected = New-Object System.Collections.Generic.List[string]
    foreach ($item in Get-ChildItem -LiteralPath $StageDir -Recurse -Force) {
        $relative = $item.FullName.Substring($StageDir.Length + 1)
        if ($item.PSIsContainer) {
            if ($item.Name -eq '__pycache__') { $unexpected.Add($relative + '\') }
        } elseif (-not $expected.ContainsKey($relative.ToLowerInvariant())) {
            $unexpected.Add($relative)
        }
    }
    if ($unexpected.Count -gt 0) {
        throw ('These files are not on the installer list but ended up in ' + $StageDir + ': ' + ($unexpected -join ', '))
    }
    Write-Log "Staged copy holds exactly $($entries.Count) app files and $($runtimeFiles.Count) runtime files."

    # 7. Compile with Inno Setup 6
    $iscc = Find-Iscc
    if (-not $iscc) {
        throw 'Inno Setup 6 was not found (ISCC.exe is not on PATH or in "Program Files (x86)\Inno Setup 6", "Program Files\Inno Setup 6" or "AppData\Local\Programs\Inno Setup 6"). Install Inno Setup 6.7.3 from https://jrsoftware.org/isdl.php, then run this again.'
    }
    $isccVersion = (Get-Item -LiteralPath $iscc).VersionInfo.ProductVersion
    Write-Log "Inno Setup: $iscc (version $isccVersion)"
    if ("$isccVersion" -notmatch '^6\.7\.') { Write-Log 'Note: this build was tested with Inno Setup 6.7.3.' }
    foreach ($old in @($SetupPath, $SetupShaPath)) {
        if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
    }
    $compile = Invoke-Program $iscc @("/DMyAppVersion=$version", $IssPath) $PackagingDir
    if ($compile.Code -ne 0) { throw "Inno Setup couldn't build the installer (exit code $($compile.Code)). See the lines above." }
    if (-not (Test-Path -LiteralPath $SetupPath -PathType Leaf)) { throw "Inno Setup finished, but $SetupPath is missing." }

    # 8. Checksum file for the release page: "<sha256>  Marteloio-Setup.exe"
    $hash = Get-Sha256 $SetupPath
    [IO.File]::WriteAllText($SetupShaPath, "$hash  $SetupName`n", $Utf8)
    $sizeMb = [Math]::Round((Get-Item -LiteralPath $SetupPath).Length / 1MB, 1)
    Write-Log ''
    Write-Log "Done: $SetupPath ($sizeMb MB)"
    Write-Log "SHA-256: $hash (also in $SetupName.sha256)"
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-Build
        exit 0
    } catch {
        Write-Log ''
        Write-Log ('BUILD FAILED: ' + $_.Exception.Message)
        exit 1
    }
}
