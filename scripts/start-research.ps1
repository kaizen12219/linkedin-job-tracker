param([string]$BuilderRoot = 'D:\rezi-builder-mcp\rezi-builder-mcp')
$ErrorActionPreference = 'Stop'
$researchRoot = [System.IO.Path]::GetFullPath($BuilderRoot)
$researchServer = Join-Path $researchRoot 'server.js'
$researchModule = Join-Path $researchRoot 'job-research.js'
if (-not (Test-Path -LiteralPath $researchServer -PathType Leaf) -or -not (Test-Path -LiteralPath $researchModule -PathType Leaf)) {
  throw 'The updated Rezi Builder with job research is missing at the supplied folder.'
}
function Get-ResearchService {
  try { return Invoke-RestMethod -Uri 'http://127.0.0.1:8787/' -TimeoutSec 2 } catch { return $null }
}
$researchStatus = Get-ResearchService
if ($researchStatus) {
  if ($researchStatus.name -ne 'resume-template-gated-builder' -or $researchStatus.tools -notcontains 'complete_job_capture') {
    throw 'Port 8787 is already occupied by an older or different service. Restart Rezi Builder to load the saved update.'
  }
  Write-Output 'Job research is ready. Reload the extension and LinkedIn tabs.'
  exit 0
}
$researchNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$researchLogs = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) 'dist\research'
New-Item -ItemType Directory -Path $researchLogs -Force | Out-Null
$researchStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$researchProcess = Start-Process -FilePath $researchNode -ArgumentList @('server.js') -WorkingDirectory $researchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $researchLogs "$researchStamp.out.log") -RedirectStandardError (Join-Path $researchLogs "$researchStamp.err.log")
for ($researchAttempt = 0; $researchAttempt -lt 20; $researchAttempt++) {
  Start-Sleep -Milliseconds 250
  $researchStatus = Get-ResearchService
  if ($researchStatus.name -eq 'resume-template-gated-builder' -and $researchStatus.tools -contains 'complete_job_capture') {
    Write-Output "Job research is ready (process $($researchProcess.Id)). Reload the extension and LinkedIn tabs."
    exit 0
  }
  if ($researchProcess.HasExited) { throw 'Rezi Builder could not start. Check the research logs under dist/research.' }
}
throw 'Rezi Builder has not confirmed readiness. Check the research logs under dist/research.'
