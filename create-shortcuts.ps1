# Add (or remove) Marteloio shortcuts for the current Windows user: a Start menu folder with
# "Marteloio" and "Stop Marteloio", and a "Marteloio" desktop shortcut. Nothing else changes:
# no registry, no admin rights, no files outside the two shortcut folders.
# -Remove deletes only shortcuts that point at this copy of Marteloio.
[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$NoDesktop,
    [string]$StartMenuDir,
    [string]$DesktopDir
)

function Get-ShortcutPlan([string]$Root, [string]$StartMenu, [string]$Desktop, [bool]$IncludeDesktop) {
    $icon = (Join-Path $Root 'assets\brand\marteloio.ico') + ',0'
    $launch = @{ Target = (Join-Path $Root 'start-all.bat'); Description = 'Start Marteloio and open it in your browser' }
    $stop = @{ Target = (Join-Path $Root 'stop.bat'); Description = 'Stop the running Marteloio app' }
    $items = @(
        [pscustomobject]@{ Path = (Join-Path $StartMenu 'Marteloio.lnk'); Target = $launch.Target; Icon = $icon; Description = $launch.Description },
        [pscustomobject]@{ Path = (Join-Path $StartMenu 'Stop Marteloio.lnk'); Target = $stop.Target; Icon = $icon; Description = $stop.Description }
    )
    if ($IncludeDesktop) {
        $items += [pscustomobject]@{ Path = (Join-Path $Desktop 'Marteloio.lnk'); Target = $launch.Target; Icon = $icon; Description = $launch.Description }
    }
    return $items
}

function Test-OwnShortcut($Shell, [string]$Path, [string]$Root) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $target = $Shell.CreateShortcut($Path).TargetPath
    if (-not $target) { return $false }
    $folder = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($target)).TrimEnd('\')
    return [string]::Equals($folder, $Root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Shortcuts([string]$Root, [string]$StartMenu, [string]$Desktop, [bool]$IncludeDesktop, [bool]$RemoveOnly) {
    foreach ($file in 'start-all.bat', 'stop.bat', 'assets\brand\marteloio.ico') {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $file) -PathType Leaf)) { throw "This folder is missing $file. Run the script from the Marteloio folder." }
    }
    $shell = New-Object -ComObject WScript.Shell
    $items = Get-ShortcutPlan $Root $StartMenu $Desktop $IncludeDesktop
    $done = @()
    if ($RemoveOnly) {
        foreach ($item in $items) {
            if (Test-OwnShortcut $shell $item.Path $Root) { Remove-Item -LiteralPath $item.Path; $done += $item.Path }
            elseif (Test-Path -LiteralPath $item.Path) { Write-Warning "Left $($item.Path) in place: it points at a different folder." }
        }
        if ((Test-Path -LiteralPath $StartMenu) -and -not (Get-ChildItem -LiteralPath $StartMenu -Force)) { Remove-Item -LiteralPath $StartMenu }
        return $done
    }
    New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null
    foreach ($item in $items) {
        $link = $shell.CreateShortcut($item.Path)
        $link.TargetPath = $item.Target
        $link.WorkingDirectory = $Root
        $link.IconLocation = $item.Icon
        $link.Description = $item.Description
        $link.WindowStyle = 7   # the launcher's console starts minimized; it closes itself once the app is open
        $link.Save()
        $done += $item.Path
    }
    return $done
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
        if (-not $StartMenuDir) { $StartMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Marteloio' }
        if (-not $DesktopDir) { $DesktopDir = [Environment]::GetFolderPath('Desktop') }
        $paths = Invoke-Shortcuts $root $StartMenuDir $DesktopDir (-not $NoDesktop) ([bool]$Remove)
        if ($Remove) {
            if ($paths) { Write-Host 'Removed the Marteloio shortcuts:' } else { Write-Host 'No Marteloio shortcuts for this folder were found.' }
        } else {
            Write-Host 'Added Marteloio to the Start menu and the desktop:'
        }
        $paths | ForEach-Object { Write-Host "  $_" }
        if (-not $Remove) { Write-Host ''; Write-Host 'If you move this folder, run create-shortcuts.bat again.' }
        exit 0
    } catch {
        Write-Error -ErrorAction Continue "Shortcuts were not changed: $($_.Exception.Message)"
        exit 1
    }
}
