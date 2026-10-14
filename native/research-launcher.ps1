$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$mutex = $null
$owned = $false
function Throw-Recovery([string]$Code, [string]$Message) {
  $failure = [Exception]::new($Message); $failure.Data['recoveryCode'] = $Code; throw $failure
}
function Get-ResearchState {
  try {
    $service = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/' -TimeoutSec 1
    if ($service.name -eq 'resume-template-gated-builder' -and $service.tools -contains 'complete_job_capture') { return 'ready' }
    return 'conflict'
  } catch {
    $socket = [Net.Sockets.TcpClient]::new()
    try { if (-not $socket.ConnectAsync('127.0.0.1', 8787).Wait(3000) -or $socket.Connected) { return 'busy' } }
    catch { }
    finally { $socket.Dispose() }
    return 'stopped'
  }
}
try {
  $config = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'config.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = [Threading.Mutex]::new($false, "Local\ApplicantAllyJobResearch-$sid")
  try { $owned = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { Throw-Recovery 'RESEARCH_STARTING' 'Research is already starting. Wait a moment and reconnect again.' }
  $state = Get-ResearchState
  if ($state -in @('conflict', 'busy')) { Throw-Recovery 'RESEARCH_PORT_CONFLICT' 'Port 8787 is occupied or unresponsive. Close the service using it, then reconnect.' }
  if ($state -eq 'ready') { $result = @{ ok=$true; status='ready'; alreadyRunning=$true } }
  else {
    foreach ($file in @($config.nodeExecutable, (Join-Path $config.workerRoot 'server.js'), (Join-Path $config.workerRoot 'job-research.js'))) {
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Throw-Recovery 'RESEARCH_FILES_MISSING' 'Research files are missing. Reinstall the recovery helper using the current package.' }
    }
    $logs = Join-Path $config.stateDir 'logs'; New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $env:HOST='127.0.0.1'; $env:PORT='8787'; $env:PUBLIC_BASE_URL='http://127.0.0.1:8787'
    $worker = Start-Process -FilePath $config.nodeExecutable -ArgumentList @('server.js') -WorkingDirectory $config.workerRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "$stamp.out.log") -RedirectStandardError (Join-Path $logs "$stamp.err.log")
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $state = Get-ResearchState
      if ($state -eq 'conflict') { Throw-Recovery 'RESEARCH_PORT_CONFLICT' 'Port 8787 is occupied by another service.' }
      if ($worker.HasExited) { Throw-Recovery 'RESEARCH_START_FAILED' 'Research could not start. Reinstall the recovery helper and try again.' }
    } while ($state -ne 'ready' -and [DateTime]::UtcNow -lt $deadline)
    if ($state -ne 'ready') { Throw-Recovery 'RESEARCH_START_TIMEOUT' 'Research has not finished starting. Wait a moment and reconnect again.' }
    $result = @{ ok=$true; status='ready'; alreadyRunning=$false }
  }
} catch {
  $code = $_.Exception.Data['recoveryCode']
  $result = @{ ok=$false; error=@{ code= $(if ($code) { $code } else { 'RESEARCH_START_FAILED' }); message= $(if ($code) { $_.Exception.Message } else { 'Research recovery needs to be reinstalled.' }) } }
} finally { if ($owned) { $mutex.ReleaseMutex() }; if ($mutex) { $mutex.Dispose() } }
[Console]::Out.Write(($result | ConvertTo-Json -Depth 5 -Compress))
