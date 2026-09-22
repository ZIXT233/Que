# Run after signing and packaging, before distributing the exact artifacts.
# Keeps Defender enabled; custom scans report detections without remediation.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Artifact,
    [string]$ReportDirectory = (Join-Path $PSScriptRoot '../logs/defender')
)

$ErrorActionPreference = 'Stop'
$reportRoot = [IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$reportPath = Join-Path $reportRoot ('scan-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
$report = [ordered]@{
    startedAt = (Get-Date).ToString('o')
    defender = $null
    scanner = $null
    artifacts = @()
    error = $null
}
$failed = $false
try {
    $status = Get-MpComputerStatus
    $report.defender = $status | Select-Object AMEngineVersion, AntivirusSignatureVersion,
        AntivirusSignatureLastUpdated, AntivirusEnabled, RealTimeProtectionEnabled
    if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled) {
        throw 'Defender antivirus and real-time protection must be enabled.'
    }
    $platform = Join-Path $env:ProgramData 'Microsoft/Windows Defender/Platform'
    $scanner = Get-ChildItem -LiteralPath $platform -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $scanner) {
        $scanner = Join-Path $env:ProgramFiles 'Windows Defender/MpCmdRun.exe'
    }
    if (-not (Test-Path -LiteralPath $scanner -PathType Leaf)) {
        throw 'MpCmdRun.exe was not found.'
    }
    $report.scanner = $scanner
    foreach ($path in $Artifact) {
        $entry = [ordered]@{ path = $path; sha256 = $null; signature = $null; exitCode = $null; output = $null; error = $null }
        try {
            $file = Get-Item -LiteralPath $path
            if ($file.PSIsContainer) { throw 'Pass individual EXE, DLL, MSI or ZIP files, not directories.' }
            # MpCmdRun requires native separators; forward slashes can yield 0x80508023.
            $entry.path = $file.FullName.Replace('/', '\')
            $entry.sha256 = (Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash
            $signature = Get-AuthenticodeSignature -LiteralPath $entry.path
            $entry.signature = [ordered]@{
                status = [string]$signature.Status
                subject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
            }
            $output = & $scanner -Scan -ScanType 3 -File $entry.path -DisableRemediation 2>&1
            $entry.exitCode = $LASTEXITCODE
            $entry.output = ($output | Out-String).Trim()
            Write-Host $entry.output
            if ($entry.exitCode -ne 0) { $failed = $true }
            # Detect a concurrent rebuild or real-time quarantine during the scan.
            if ((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -ne $entry.sha256) {
                throw 'Artifact changed during the scan; result is invalid.'
            }
        } catch {
            $entry.error = $_.Exception.Message
            $failed = $true
        }
        $report.artifacts += $entry
    }
} catch {
    $report.error = $_.Exception.Message
    $failed = $true
} finally {
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Host "Defender report: $reportPath"
}
if ($failed) { throw "Artifact scan did not pass. See $reportPath" }
