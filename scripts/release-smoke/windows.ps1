param([Parameter(Mandatory=$true)][string]$Installer, [string]$Output = 'desktop-smoke-results')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run installer smoke tests in a disposable CI runner.' }
$Installer = (Resolve-Path $Installer).Path
New-Item -ItemType Directory -Force $Output | Out-Null
$Output = (Resolve-Path $Output).Path
Get-FileHash $Installer -Algorithm SHA256 | Format-List | Out-File "$Output\artifact.sha256"
$installDir = Join-Path $env:RUNNER_TEMP 'anagram-installed'
$driver = $null
try {
  $install = Start-Process $Installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
  $binary = Join-Path $installDir 'anagram.exe'
  if (!(Test-Path $binary)) { throw 'Installer did not install anagram.exe' }
  # Match the actual WebView2 runtime, not the separately installed Edge browser.
  $runtime = Get-ChildItem "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" |
    Sort-Object { [version]$_.VersionInfo.ProductVersion } -Descending | Select-Object -First 1
  if (!$runtime) { throw 'WebView2 runtime missing after installation' }
  $version = $runtime.VersionInfo.ProductVersion
  $zip = Join-Path $env:RUNNER_TEMP 'edgedriver.zip'
  $driverDir = Join-Path $env:RUNNER_TEMP 'edgedriver'
  Invoke-WebRequest "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $driverDir -Force
  $driver = Start-Process tauri-driver -ArgumentList @('--native-driver', "`"$driverDir\msedgedriver.exe`"") -PassThru -RedirectStandardOutput "$Output\driver.log" -RedirectStandardError "$Output\driver-error.log"
  for ($i = 0; $i -lt 30; $i++) {
    if ($driver.HasExited) { throw 'Native WebDriver exited' }
    try { Invoke-WebRequest 'http://127.0.0.1:4444/status' -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
  }
  $env:ANAGRAM_DISPOSABLE_TEST = '1'
  node scripts/release-smoke/desktop.mjs $binary $Output
  if ($LASTEXITCODE -ne 0) { throw 'Installed Windows app failed smoke checks' }
} finally {
  if ($driver -and !$driver.HasExited) { taskkill /PID $driver.Id /T /F | Out-Null }
}
