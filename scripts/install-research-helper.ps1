param([string]$BuilderRoot = 'D:\rezi-builder-mcp\rezi-builder-mcp', [string]$NodePath = '')
$ErrorActionPreference = 'Stop'
$trackerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workerRoot = [IO.Path]::GetFullPath($BuilderRoot)
foreach ($relative in @('server.js', 'job-research.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $workerRoot $relative) -PathType Leaf)) { throw 'Research files are missing from the selected worker folder.' }
}
if (-not $NodePath) {
  $bundledNode = Join-Path $env:USERPROFILE 'Documents\Workspace\WindowTop\dist\mcp\node.exe'
  $NodePath = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $bundledNode } else { (Get-Command node -CommandType Application -ErrorAction Stop).Source }
}
$nodeExecutable = [IO.Path]::GetFullPath($NodePath)
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) { throw 'A Node.js runtime is required for research recovery.' }
$hostName = 'com.applicantally.job_research'
$hostRoot = Join-Path $env:LOCALAPPDATA 'ApplicantAlly\JobResearchRecovery'
New-Item -ItemType Directory -Path $hostRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $trackerRoot 'native\research-host.cjs') -Destination (Join-Path $hostRoot 'research-host.cjs') -Force
Copy-Item -LiteralPath (Join-Path $trackerRoot 'native\research-launcher.ps1') -Destination (Join-Path $hostRoot 'research-launcher.ps1') -Force
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $hostRoot 'config.json'), (@{ version=1; nodeExecutable=$nodeExecutable; workerRoot=$workerRoot; stateDir=$hostRoot } | ConvertTo-Json), $utf8)
$launcher = Join-Path $hostRoot 'research-host.cmd'
$quotedNode = $nodeExecutable.Replace('%', '%%')
[IO.File]::WriteAllText($launcher, "@echo off`r`nchcp 65001 >nul`r`n`"$quotedNode`" `"%~dp0research-host.cjs`" `"%~1`"`r`n", $utf8)
$manifestPath = Join-Path $hostRoot 'com.applicantally.job_research.json'
[IO.File]::WriteAllText($manifestPath, (@{ name=$hostName; description='Start or check LinkedIn job research'; path=$launcher; type='stdio'; allowed_origins=@('chrome-extension://lomiekljcjnlhfpklnjmmhomknfigofn/') } | ConvertTo-Json), $utf8)
# Per-user registration; only this extension can invoke the fixed start/status helper.
foreach ($browserKey in @('Software\Google\Chrome', 'Software\Microsoft\Edge', 'Software\Chromium')) {
  $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$browserKey\NativeMessagingHosts\$hostName")
  try { $registryKey.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $registryKey.Dispose() }
}
Write-Output 'Research recovery is installed. Reload the extension, then click Start / reconnect research in its popup.'
