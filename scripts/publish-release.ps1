# Usage (from repo root):
#   $env:GH_TOKEN = '<github personal access token with repo scope>'
#   .\scripts\publish-release.ps1
#
# Builds are expected in dist/ from `npm run build`.
# This script uploads dist artifacts to an existing or new GitHub Release.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:GH_TOKEN) {
    throw 'Set GH_TOKEN to a GitHub personal access token with repo scope.'
}

if (-not (Test-Path 'google-oauth.config.json')) {
    throw 'google-oauth.config.json is required in the project root before building.'
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$setup = Join-Path $root "dist\Daymark-Setup-$version.exe"
$blockmap = "$setup.blockmap"
$latest = Join-Path $root 'dist\latest.yml'

if (-not (Test-Path $setup)) {
    Write-Host "Building Daymark $version..."
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    npm run build
}

foreach ($file in @($setup, $blockmap, $latest)) {
    if (-not (Test-Path $file)) {
        throw "Missing build artifact: $file"
    }
}

Write-Host "Publishing GitHub Release $tag..."
npm run build:publish
