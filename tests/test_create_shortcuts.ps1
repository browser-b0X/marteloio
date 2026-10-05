# Shortcut tests. They write only inside a temporary folder, never to the real Start menu or desktop.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../create-shortcuts.ps1')
$script:checks = 0
function Assert-Check($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:checks++
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('marteloio-shortcuts-' + [guid]::NewGuid().ToString('N'))
$shell = New-Object -ComObject WScript.Shell
try {
    $menu = Join-Path $temp 'Start Menu\Marteloio'
    $desk = Join-Path $temp 'Desktop'
    New-Item -ItemType Directory -Force -Path $desk | Out-Null

    $made = @(Invoke-Shortcuts $root $menu $desk $true $false)
    Assert-Check ($made.Count -eq 3) 'Expected Start menu launch and stop shortcuts plus a desktop shortcut'
    $launch = $shell.CreateShortcut((Join-Path $menu 'Marteloio.lnk'))
    Assert-Check ($launch.TargetPath -ieq (Join-Path $root 'start-all.bat')) 'Launch shortcut must run start-all.bat'
    Assert-Check ($launch.WorkingDirectory -ieq $root) 'Launch shortcut must start in the project folder'
    Assert-Check ($launch.IconLocation -ieq ((Join-Path $root 'assets\brand\marteloio.ico') + ',0')) 'Launch shortcut must use the Marteloio icon'
    Assert-Check ($launch.WindowStyle -eq 7) 'Launcher console should start minimized'
    $stop = $shell.CreateShortcut((Join-Path $menu 'Stop Marteloio.lnk'))
    Assert-Check ($stop.TargetPath -ieq (Join-Path $root 'stop.bat')) 'Stop shortcut must run stop.bat'
    Assert-Check ($shell.CreateShortcut((Join-Path $desk 'Marteloio.lnk')).TargetPath -ieq (Join-Path $root 'start-all.bat')) 'Desktop shortcut must run start-all.bat'

    # Running it again replaces the shortcuts instead of failing or duplicating them.
    $again = @(Invoke-Shortcuts $root $menu $desk $true $false)
    Assert-Check ($again.Count -eq 3 -and @(Get-ChildItem -LiteralPath $menu).Count -eq 2) 'Re-running must not duplicate shortcuts'

    # Removal deletes only shortcuts that point at this folder.
    $foreign = $shell.CreateShortcut((Join-Path $desk 'Marteloio.lnk'))
    $foreign.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'
    $foreign.Save()
    $removed = @(Invoke-Shortcuts $root $menu $desk $true $true 3>$null)
    Assert-Check ($removed.Count -eq 2) 'Remove should delete the two Start menu shortcuts'
    Assert-Check (Test-Path -LiteralPath (Join-Path $desk 'Marteloio.lnk')) 'A shortcut pointing elsewhere must be left in place'
    Assert-Check (-not (Test-Path -LiteralPath $menu)) 'The empty Start menu folder should be removed'

    # Start menu only.
    $menuOnly = @(Invoke-Shortcuts $root (Join-Path $temp 'Menu2\Marteloio') (Join-Path $temp 'Desktop2') $false $false)
    Assert-Check ($menuOnly.Count -eq 2 -and -not (Test-Path -LiteralPath (Join-Path $temp 'Desktop2'))) '-NoDesktop must not touch the desktop'

    # A folder that is not a Marteloio copy is refused before anything is written.
    $empty = Join-Path $temp 'NotMarteloio'
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    $refused = $false
    try { Invoke-Shortcuts $empty (Join-Path $temp 'Menu3') (Join-Path $temp 'Desktop3') $true $false | Out-Null } catch { $refused = $true }
    Assert-Check ($refused -and -not (Test-Path -LiteralPath (Join-Path $temp 'Menu3'))) 'A folder without the launcher must be refused'
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
Write-Host "$script:checks shortcut assertions passed (temporary folders only)."
