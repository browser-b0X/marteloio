# Windows service stopping, intentionally fail closed. No image-name or port-only kills.
# -DryRun performs the same ownership checks without sending shutdown or terminating.
[CmdletBinding()]
param([switch]$DryRun)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not ('MarteloioProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class MarteloioProcess {
    [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string s, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static string[] Arguments(string command) {
        int count; IntPtr p = CommandLineToArgvW(command, out count);
        if (p == IntPtr.Zero) throw new Win32Exception();
        try {
            string[] args = new string[count];
            for (int i=0; i<count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, i * IntPtr.Size));
            return args;
        } finally { LocalFree(p); }
    }
    static long Created(IntPtr h) {
        long c, e, k, u;
        if (!GetProcessTimes(h, out c, out e, out k, out u)) throw new Win32Exception();
        return c;
    }
    public static long CreationTime(int id) {
        IntPtr h = OpenProcess(0x1000, false, id);
        if (h == IntPtr.Zero) throw new Win32Exception();
        try { return Created(h); } finally { CloseHandle(h); }
    }
    public static void StopExpected(int id, long expected) {
        // Identity check and termination use the SAME handle, so PID reuse cannot
        // redirect termination to a replacement process between these operations.
        IntPtr h = OpenProcess(0x1001, false, id);
        if (h == IntPtr.Zero) throw new Win32Exception();
        try {
            if (Created(h) != expected) throw new InvalidOperationException("Process identity changed; refusing to stop it.");
            if (!TerminateProcess(h, 1)) throw new Win32Exception();
        } finally { CloseHandle(h); }
    }
}
'@
}

function Get-ServicePorts([string]$Project) {
    $values = @{ PORT = '8080' }
    $value = [Environment]::GetEnvironmentVariable('PORT')
    if ($null -ne $value) { $values.PORT = $value }
    $envPath = Join-Path $Project '.env'
    if (Test-Path -LiteralPath $envPath) {
        # Match the Windows launcher: .env values override inherited values.
        # Never evaluate, expand, or print any .env value (including credentials).
        foreach ($line in [IO.File]::ReadAllLines($envPath)) {
            if ($line -cmatch '^\s*(PORT)\s*=(.*)$') {
                $values[$Matches[1]] = $Matches[2].Trim()
            }
        }
    }
    $number = 0
    if ($values.PORT -notmatch '^\d{1,5}$' -or -not [int]::TryParse($values.PORT, [ref]$number) -or $number -lt 1 -or $number -gt 65535) {
        throw "Invalid PORT. Use a port number between 1 and 65535."
    }
    $values.PORT = $number
    return $values
}

function Get-ProjectId([string]$Project) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Project.Replace('/', '\').ToLowerInvariant())
        return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant().Substring(0, 16)
    } finally { $hash.Dispose() }
}

function Test-ExactPath([string]$Candidate, [string]$Expected) {
    # Relative paths cannot prove a process's working directory. Never resolve them
    # against THIS shell's working directory and assume they identify the process.
    if ($Candidate -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\)') { return $false }
    try { return [string]::Equals([IO.Path]::GetFullPath($Candidate), $Expected, [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}

function Test-ServiceCommand([string]$Command, [string]$Project) {
    # Parse real arguments, not a substring (a filename in a comment or -c string
    # is not ownership).
    if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
    $arguments = [MarteloioProcess]::Arguments($Command)
    if ($arguments.Count -ne 2) { return $false }
    $exe = [IO.Path]::GetFileName($arguments[0]).ToLowerInvariant()
    $isPython = $exe -in @('python.exe', 'pythonw.exe', 'python', 'python3.exe')
    return $isPython -and (Test-ExactPath $arguments[1] (Join-Path $Project 'server.py'))
}

function Get-ListenerIds([int]$Port) {
    # Failure to enumerate is an error, never evidence that a port is free.
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Port | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-ProcessIdentity([int]$ProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $process -or -not $process.CommandLine -or -not $process.CreationDate) { throw "Cannot identify PID $ProcessId." }
    $created = [MarteloioProcess]::CreationTime($ProcessId)
    # CIM timestamps have microsecond precision; native FILETIME has 100ns precision.
    if ([Math]::Floor($created / [decimal]10) -ne [Math]::Floor($process.CreationDate.ToUniversalTime().ToFileTimeUtc() / [decimal]10)) {
        throw "PID $ProcessId changed while checking its identity."
    }
    return [pscustomobject]@{ Id = $ProcessId; ParentId = [int]$process.ParentProcessId; Created = $created; Command = $process.CommandLine }
}

function Test-RelayIdentity([int]$Port, [string]$ProjectId) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -MaximumRedirection 0
        # 'LanzaLister' is the pre-rename relay, so the first relaunch after updating
        # can still stop it cooperatively.
        return $health.ok -eq $true -and $health.app -cin @('Marteloio', 'LanzaLister') -and $health.instance -ceq $ProjectId
    } catch { return $false }
}

function Stop-VerifiedProcess($Identity) {
    # Already gone is success. An existing replacement must pass native identity.
    if ($null -eq (Get-Process -Id $Identity.Id -ErrorAction SilentlyContinue)) { return }
    [MarteloioProcess]::StopExpected($Identity.Id, $Identity.Created)
}

function Invoke-ServiceStop([string]$Project, [bool]$Preview) {
    $ports = Get-ServicePorts $Project
    $projectId = Get-ProjectId $Project
    $relay = $null; $relayCooperative = $false; $relayExact = $false
    # Complete preflight BEFORE stopping anything, so a conflict leaves the
    # currently working service intact. No process-tree or image-name termination.
    $port = $ports.PORT
    $ids = @(Get-ListenerIds $port)
    if ($ids.Count -gt 1) { throw "Multiple processes listen on port $port; refusing to guess ownership." }
    if (-not $ids.Count) {
        Write-Host "Nothing listening on port $port."
    } else {
        $identity = Get-ProcessIdentity $ids[0]
        $exact = Test-ServiceCommand $identity.Command $Project
        $relayCooperative = Test-RelayIdentity $port $projectId
        if (-not $exact -and -not $relayCooperative) { throw "Port $port is not a verified relay for this project. No process was stopped." }
        $relay = $identity; $relayExact = $exact
        Write-Host "Verified project relay on port $port (PID $($ids[0]))."
    }
    if ($Preview) { Write-Host 'Dry run complete. No shutdown request or process termination was sent.'; return }
    if ($null -ne $relay) {
        if ($relayCooperative) {
            # Recheck before obtaining the per-run token. Never print or persist it.
            if (-not (Test-RelayIdentity $ports.PORT $projectId)) { throw 'Relay identity changed; stopping cancelled.' }
            try {
                $session = Invoke-RestMethod -Uri "http://127.0.0.1:$($ports.PORT)/session" -TimeoutSec 3 -MaximumRedirection 0
                $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($ports.PORT)/shutdown" -Headers @{ 'X-App-Token' = $session.token } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 -MaximumRedirection 0
            } catch { Write-Host 'Cooperative shutdown did not finish; checking the verified process.' }
            $deadline = [DateTime]::UtcNow.AddSeconds(18)
            while (@(Get-ListenerIds $ports.PORT).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
        }
        if (@(Get-ListenerIds $ports.PORT).Count -gt 0) {
            if (-not $relayExact) { throw 'Relay did not exit and has no absolute script path. Refusing forced stop; close its own console manually.' }
            Stop-VerifiedProcess $relay
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $remaining = @(Get-ListenerIds $ports.PORT)
        if (-not $remaining.Count) { Write-Host 'Marteloio relay stopped.'; return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The app port is still occupied. Refusing to relaunch; inspect the service manually.'
}

# Dot-source only for the focused offline tests; normal script runs always preflight.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-ServiceStop ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')) ([bool]$DryRun)
        exit 0
    } catch {
        Write-Error -ErrorAction Continue "Safe stop failed: $($_.Exception.Message)"
        exit 1
    }
}
