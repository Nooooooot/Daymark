Add-Type -AssemblyName System.Drawing

$assets = 'C:\Users\User\Projects\task-app-desktop\assets'
$srcPath = Join-Path $assets 'daymark-icon-sketch-b-coral.png'
$outPath = Join-Path $assets 'icon.png'
$archive = Join-Path $assets 'daymark-icon-b-final.png'
$preview = Join-Path $assets 'icon-16-preview.png'

function Test-OutsideBg([int]$r, [int]$g, [int]$b) {
  $min = [Math]::Min($r, [Math]::Min($g, $b))
  $max = [Math]::Max($r, [Math]::Max($g, $b))
  if ($min -ge 232) { return $true }
  if ($max -ge 225 -and ($max - $min) -le 18) { return $true }
  return $false
}

$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$w = $src.Width; $h = $src.Height
$pf = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$out = New-Object System.Drawing.Bitmap $w, $h, $pf

for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $c = $src.GetPixel($x, $y)
    $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($c.A, $c.R, $c.G, $c.B))
  }
}
$src.Dispose()

$outside = New-Object 'bool[,]' $w, $h
$q = New-Object System.Collections.Generic.Queue[object]
$wm = $w - 1; $hm = $h - 1; $wm1 = $w - 2; $hm1 = $h - 2
$seeds = @(
  @(0,0), @(1,0), @(0,1),
  @($wm,0), @($wm1,0), @($wm,1),
  @(0,$hm), @(1,$hm), @(0,$hm1),
  @($wm,$hm), @($wm1,$hm), @($wm,$hm1)
)
foreach ($s in $seeds) {
  $sx = $s[0]; $sy = $s[1]
  if ($outside[$sx,$sy]) { continue }
  $c = $out.GetPixel($sx, $sy)
  if (Test-OutsideBg ([int]$c.R) ([int]$c.G) ([int]$c.B)) {
    $outside[$sx,$sy] = $true
    $q.Enqueue(@($sx, $sy))
  }
}
while ($q.Count -gt 0) {
  $p = $q.Dequeue(); $x = $p[0]; $y = $p[1]
  foreach ($d in @(@(0,1), @(0,-1), @(1,0), @(-1,0))) {
    $nx = $x + $d[0]; $ny = $y + $d[1]
    if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $w -or $ny -ge $h) { continue }
    if ($outside[$nx,$ny]) { continue }
    $c = $out.GetPixel($nx, $ny)
    if (Test-OutsideBg ([int]$c.R) ([int]$c.G) ([int]$c.B)) {
      $outside[$nx,$ny] = $true
      $q.Enqueue(@($nx, $ny))
    }
  }
}

for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    if ($outside[$x,$y]) {
      $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    }
  }
}

$out.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$out.Save($archive, [System.Drawing.Imaging.ImageFormat]::Png)

$p16 = New-Object System.Drawing.Bitmap 16, 16, $pf
$pg = [System.Drawing.Graphics]::FromImage($p16)
$pg.Clear([System.Drawing.Color]::Transparent)
$pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$pg.DrawImage($out, 0, 0, 16, 16)
$pg.Dispose()
$p16.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
$p16.Dispose()
$out.Dispose()

Write-Output 'B sketch applied (corners transparent)'
