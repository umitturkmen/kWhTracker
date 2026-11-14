$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$config = Join-Path $project 'agent.config.json'
$envFile = Join-Path $project '.env'
if (!(Test-Path -LiteralPath $config) -or !(Test-Path -LiteralPath $envFile)) {
    throw 'Configure agent.config.json and .env before installing the Windows task.'
}
$node = (Get-Command node.exe).Source
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''' + $node +
    ''' --env-file=.env src/agent.mjs; exit $LASTEXITCODE"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$name = 'Cihaz Takip PC'
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
