# Daymark GitHub Release
#
# PowerShell 4줄 (package.json version 올린 뒤):
#   cd C:\Users\User\Projects\Daymark
#   git pull
#   .\scripts\release.ps1
#   Start-Process "https://github.com/Nooooooot/Daymark/actions"
#
# → main push + v1.0.6 태그 push 후 GitHub Actions가 exe 빌드·Release 업로드
# → 2~5분 뒤 https://github.com/Nooooooot/Daymark/releases 에 Setup exe 확인
#
# 로컬에서 직접 빌드·업로드할 때만 (GH_TOKEN 필요):
#   cd C:\Users\User\Projects\Daymark
#   $env:GH_TOKEN = "ghp_..."
#   $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
#   & "$env:ProgramFiles\nodejs\npm.cmd" run build:publish

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root '.git'))) {
    throw "Git 저장소가 아닙니다. Daymark 폴더에서 실행하세요: C:\Users\User\Projects\Daymark"
}

function Get-PackageVersion {
    $path = Join-Path $root 'package.json'
    $raw = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
    if ($raw -match '"version"\s*:\s*"([^"]+)"') {
        return $Matches[1]
    }
    throw 'package.json에서 version을 찾을 수 없습니다.'
}

$version = Get-PackageVersion
$tag = "v$version"

Write-Host ""
Write-Host "Daymark 릴리즈: $tag" -ForegroundColor Cyan
Write-Host "폴더: $root"
Write-Host ""

$changes = git status --porcelain
if ($changes) {
    git add .
    git commit -m "Release $tag"
    Write-Host "커밋 완료" -ForegroundColor Green
} else {
    Write-Host "커밋할 변경 없음 (이미 커밋됐거나 수정 없음)" -ForegroundColor Yellow
}

Write-Host "main push..."
git push origin main

if (-not (git tag -l $tag)) {
    git tag $tag
    Write-Host "태그 생성: $tag" -ForegroundColor Green
} else {
    Write-Host "태그 $tag 이미 있음" -ForegroundColor Yellow
}

Write-Host "태그 push... (GitHub Actions가 빌드 시작)"
git push origin $tag

Write-Host ""
Write-Host "완료!" -ForegroundColor Green
Write-Host "Actions: https://github.com/Nooooooot/Daymark/actions"
Write-Host "Release: https://github.com/Nooooooot/Daymark/releases/tag/$tag"
Write-Host ""
Write-Host "2~5분 후 Releases에 Daymark-Setup-$version.exe 가 올라오면 성공입니다."
