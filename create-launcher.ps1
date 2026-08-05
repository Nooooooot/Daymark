$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'assets\icon.ico'
$shortcutPath = Join-Path $root 'Daymark.lnk'

if (-not (Test-Path $electron)) {
    Write-Host 'Electron이 없습니다. 먼저 npm install을 실행해 주세요.' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $icon)) {
    $icon = Join-Path $root 'assets\icon.png'
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electron
$shortcut.Arguments = "`"$root`""
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 1
$shortcut.Description = 'Daymark · 일정과 업무'
if (Test-Path $icon) {
    $shortcut.IconLocation = "$icon,0"
}
$shortcut.Save()

Write-Host "실행 아이콘 생성: $shortcutPath" -ForegroundColor Green
