# Offline ownership/preflight tests. Never call native process termination.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../stop-services.ps1')
$script:checks = 0
function Assert-Check($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:checks++
}
$project = 'C:\Fixtures\Marteloio'
$relayCommand = 'python.exe "C:\Fixtures\Marteloio\server.py"'
Assert-Check (Test-ServiceCommand $relayCommand $project) 'Absolute relay must match'
foreach ($command in @(
    'python.exe server.py',
    'python.exe "C:\Other\server.py"',
    'python.exe -c "print(''C:\Fixtures\Marteloio\server.py'')"',
    'unrelated.exe "C:\Fixtures\Marteloio\server.py"',
    ($relayCommand + ' --extra'),
    '"C:\Tools\litellm.exe" --config "C:\Fixtures\Marteloio\litellm-config.yaml" --port 4000'
)) { Assert-Check (-not (Test-ServiceCommand $command $project)) 'Ambiguous/unrelated relay accepted' }

# Replace every OS/network effect. Preflight cannot stop anything if the occupied
# port fails ownership, and DryRun must never call shutdown/terminate.
$script:stops = @()
$script:foreign = $true
$script:cooperative = $false
function Get-ServicePorts { return @{PORT=8080} }
function Get-ListenerIds([int]$Port) { if ($Port -eq 8080) { return @(101) }; throw "Unexpected port $Port" }
function Get-ProcessIdentity([int]$ProcessId) {
    $command = if ($script:foreign) { 'python.exe other.py' } else { $relayCommand }
    return [pscustomobject]@{Id=$ProcessId; ParentId=0; Created=123; Command=$command}
}
function Test-RelayIdentity { return $script:cooperative }
function Stop-VerifiedProcess($Identity) { $script:stops += $Identity.Id }
function Invoke-RestMethod { throw 'Test attempted real shutdown/network' }
$refused = $false
try { Invoke-ServiceStop $project $false } catch { $refused = $true }
Assert-Check $refused 'Foreign relay should fail preflight'
Assert-Check ($script:stops.Count -eq 0) 'Foreign relay was stopped'
$script:foreign = $false
Invoke-ServiceStop $project $true
Assert-Check ($script:stops.Count -eq 0) 'Dry run attempted termination'
function Get-ProcessIdentity { throw 'Process identity changed or unavailable' }
$refused = $false
try { Invoke-ServiceStop $project $false } catch { $refused = $true }
Assert-Check $refused 'Missing identity should fail closed'
Assert-Check ($script:stops.Count -eq 0) 'Failed identity attempted termination'

# Exercise cooperative completion, including empty listener output under StrictMode.
$script:listeners = @{8080=101}
$script:httpCalls = @()
$script:cooperative = $true
function Get-ListenerIds([int]$Port) { if ($script:listeners.ContainsKey($Port)) { return @($script:listeners[$Port]) }; return @() }
function Get-ProcessIdentity([int]$ProcessId) {
    return [pscustomobject]@{Id=$ProcessId; ParentId=0; Created=123; Command=$relayCommand}
}
function Invoke-RestMethod {
    param($Uri, $Method, $Headers, $ContentType, $Body, $TimeoutSec, $MaximumRedirection)
    $script:httpCalls += $Uri
    if ($Uri.EndsWith('/session')) { return @{token='fixture'} }
    if ($Uri.EndsWith('/shutdown')) { $script:listeners.Remove(8080); return @{ok=$true} }
    throw 'Unexpected fixture HTTP request'
}
Invoke-ServiceStop $project $false
Assert-Check ($script:httpCalls.Count -eq 2) 'Cooperative shutdown missing'
Assert-Check (101 -notin $script:stops) 'Cooperatively stopped relay was force-stopped'
Assert-Check ($script:listeners.Count -eq 0) 'Mock listeners remain'
Assert-Check (-not ($script:httpCalls | Where-Object { $_ -match ':4000/' })) 'Contacted the retired router port'
Write-Host "$script:checks safe-stop assertions passed (no OS process changes)."
