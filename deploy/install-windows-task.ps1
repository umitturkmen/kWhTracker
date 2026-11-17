$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$config = Join-Path $project 'agent.config.json'
$envFile = Join-Path $project '.env'
if (!(Test-Path -LiteralPath $config) -or !(Test-Path -LiteralPath $envFile)) {
    throw 'Configure agent.config.json and .env before installing the Windows task.'
}
$node = (Get-Command node.exe).Source
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$source = Join-Path $PSScriptRoot 'agent-launcher.cs'
$buildDir = Join-Path $project 'data\windows-task'
$null = New-Item -ItemType Directory -Path $buildDir -Force
# A source change gets a new executable so the running task can keep its file until registration succeeds.
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$launcher = Join-Path $buildDir "agent-launcher-$hash.exe"
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    & $compiler /nologo /optimize+ /target:winexe "/out:$launcher" $source
    if ($LASTEXITCODE -ne 0) { throw 'Agent launcher compilation failed.' }
}
$action = New-ScheduledTaskAction -Execute $launcher -Argument ('"' + $node + '"') -WorkingDirectory $project
$onLogon = New-ScheduledTaskTrigger -AtLogOn -User $account
# Restore the collector after exits that Task Scheduler does not automatically retry.
$recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$recovery.Repetition.StopAtDurationEnd = $false
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$name = 'Cihaz Takip PC'
$task = Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -Trigger @($onLogon, $recovery) -Principal $principal -Settings $settings -Force
if ($task.State -eq 'Running') { Stop-ScheduledTask -InputObject $task }
Start-ScheduledTask -InputObject $task
Get-ScheduledTask -TaskName $name -TaskPath '\' | Select-Object TaskName, State
