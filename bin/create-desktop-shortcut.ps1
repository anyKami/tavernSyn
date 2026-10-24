param(
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [string]$DesktopPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$launcherFullPath = (Resolve-Path -LiteralPath $LauncherPath).Path
if (-not (Test-Path -LiteralPath $launcherFullPath -PathType Leaf) -or [IO.Path]::GetFileName($launcherFullPath) -ne 'Start-TavernSyn.cmd') { throw 'Expected Start-TavernSyn.cmd.' }
$workingDirectory = Split-Path -LiteralPath $launcherFullPath
$desktopDirectory = if ($DesktopPath) { [IO.Path]::GetFullPath($DesktopPath) } else { [Environment]::GetFolderPath('DesktopDirectory') }
if (-not $desktopDirectory) { throw 'Windows Desktop folder is unavailable.' }
if (-not (Test-Path -LiteralPath $desktopDirectory -PathType Container)) { New-Item -ItemType Directory -Path $desktopDirectory -Force | Out-Null }
$shellObject = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $desktopDirectory 'TavernSyn.lnk'
$suffix = 1
while (Test-Path -LiteralPath $shortcutPath) {
    $existing = $shellObject.CreateShortcut($shortcutPath)
    if ($existing.TargetPath -eq $launcherFullPath) { break }
    $suffix++
    $shortcutPath = Join-Path $desktopDirectory ('TavernSyn (' + $suffix + ').lnk')
}
$stagedShortcut = Join-Path $desktopDirectory ('.TavernSyn-' + [guid]::NewGuid().ToString() + '.lnk')
$shortcut = $shellObject.CreateShortcut($stagedShortcut)
$shortcut.TargetPath = $launcherFullPath
$shortcut.WorkingDirectory = $workingDirectory
$shortcut.WindowStyle = 1
$shortcut.Description = 'TavernSyn managed launcher'
$iconPath = Join-Path $workingDirectory 'public\favicon.ico'
if (Test-Path -LiteralPath $iconPath -PathType Leaf) { $shortcut.IconLocation = $iconPath + ',0' }
$shortcut.Save()
Move-Item -LiteralPath $stagedShortcut -Destination $shortcutPath -Force
@{ shortcutPath=$shortcutPath; target=$launcherFullPath; workingDirectory=$workingDirectory } | ConvertTo-Json -Compress
