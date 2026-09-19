param(
    [string]$Codex = 'codex',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$CodexArgs
)
$ErrorActionPreference = 'Stop'
# Run from the same shell/directory as the slow session. No config, model,
# sandbox, hook command, or terminal overrides are applied.
$traceDir = Join-Path ([IO.Path]::GetTempPath()) ('que-codex-trace-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($traceDir) | Out-Null
$savedDebug = $env:QUE_HOOK_DEBUG
$savedFile = $env:QUE_HOOK_DEBUG_FILE
$sources = @()
$jobs = @()
try {
    foreach ($kind in @('Start', 'Stop')) {
        $source = 'QueCodex-' + $kind + '-' + [guid]::NewGuid()
        $data = @{ File = (Join-Path $traceDir ($kind.ToLower() + '.jsonl')); Kind = $kind }
        $job = Register-CimIndicationEvent -Query "SELECT * FROM Win32_Process${kind}Trace" -SourceIdentifier $source -MessageData $data -Action {
            $p = $Event.SourceEventArgs.NewEvent
            # Process metadata only: no command lines, environment, prompts or tokens.
            $row = @{ type = $Event.MessageData.Kind; at = [DateTime]::FromFileTimeUtc([long]$p.TIME_CREATED).ToString('o'); pid = [int]$p.ProcessID; ppid = [int]$p.ParentProcessID; name = [string]$p.ProcessName }
            if ($Event.MessageData.Kind -eq 'Stop') { $row.exitCode = [long]$p.ExitStatus }
            [IO.File]::AppendAllText($Event.MessageData.File, (($row | ConvertTo-Json -Compress) + "`n"))
        }
        $sources += $source
        $jobs += $job
    }
    @{ started = [DateTime]::UtcNow.ToString('o'); rootPid = $PID; cwd = (Get-Location).Path; launcher = $Codex } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $traceDir 'run.json') -Encoding utf8
    $env:QUE_HOOK_DEBUG = '1'
    $env:QUE_HOOK_DEBUG_FILE = Join-Path $traceDir 'hook.jsonl'
    Write-Host "Trace: $traceDir"
    Write-Host 'Use Codex normally, reproduce the slow hook, then exit Codex to finish capture.'
    & $Codex @CodexArgs
} finally {
    $env:QUE_HOOK_DEBUG = $savedDebug
    $env:QUE_HOOK_DEBUG_FILE = $savedFile
    Start-Sleep -Milliseconds 300
    foreach ($source in $sources) { Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue }
    foreach ($job in $jobs) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    Write-Host "Trace saved: $traceDir"
    Write-Host 'Process events include other running processes (names and IDs only); filter descendants before sharing.'
}
