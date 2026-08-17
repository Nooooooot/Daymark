const path = require('path');
const { spawnSync } = require('child_process');

/** Embed Daymark icon into the Windows exe without winCodeSign (symlink issues). */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(context.packager.projectDir, 'assets', 'icon.ico');
  const rceditExe = path.join(
    context.packager.projectDir,
    'node_modules',
    'rcedit',
    'bin',
    'rcedit-x64.exe'
  );

  const result = spawnSync(rceditExe, [exePath, '--set-icon', iconPath], {
    stdio: 'pipe',
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Failed to set Daymark.exe icon via rcedit${detail ? `: ${detail}` : ''}`);
  }
};
