$ErrorActionPreference = 'Stop'
$trackerRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$trackerDist = Join-Path $trackerRoot 'dist'
$trackerVersion = (Get-Content -LiteralPath (Join-Path $trackerRoot 'manifest.json') -Raw | ConvertFrom-Json).version
$trackerArchive = Join-Path $trackerDist ("linkedin-job-tracker-{0}-{1}.zip" -f $trackerVersion, (Get-Date -Format 'yyyyMMdd-HHmmss'))
# Deliberate allowlist: no legacy server scripts, keys, .env, source credentials, or tests.
$trackerFiles = @('manifest.json', 'popup.html', 'popup.css', 'src/background.js', 'src/google-sheets-client.js', 'src/banned-companies.js', 'src/popup-kai-flow.js', 'src/scraper.js', 'src/content.js')
foreach ($trackerRelative in $trackerFiles) {
  $trackerSource = [System.IO.Path]::GetFullPath((Join-Path $trackerRoot $trackerRelative))
  if (-not $trackerSource.StartsWith($trackerRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $trackerSource -PathType Leaf)) { throw "Missing or unsafe extension asset: $trackerRelative" }
}
New-Item -ItemType Directory -Path $trackerDist -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$trackerZip = [System.IO.Compression.ZipFile]::Open($trackerArchive, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($trackerRelative in $trackerFiles) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($trackerZip, (Join-Path $trackerRoot $trackerRelative), $trackerRelative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $trackerZip.Dispose() }
Write-Output $trackerArchive
