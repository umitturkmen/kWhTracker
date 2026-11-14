$ErrorActionPreference = 'Stop'
$windowsAccount = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]::new($windowsAccount)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open PowerShell as administrator, then run this script.'
}

$driver = Get-CimInstance Win32_SystemDriver -Filter "Name='PawnIO'" -ErrorAction SilentlyContinue
if (!$driver) { throw 'Install the signed PawnIO driver from https://pawnio.eu/ first.' }

$root = Join-Path $env:ProgramFiles 'WattIz'
$library = Join-Path $root 'cpu-reader'
$data = Join-Path $env:ProgramData 'WattIz'
$null = New-Item -ItemType Directory -Path $library,$data -Force
icacls $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set sensor output permissions.' }

$zip = Join-Path $root 'LibreHardwareMonitor.zip'
$url = 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip'
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
$digest = '086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001'
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $digest) { throw 'Unexpected LibreHardwareMonitor SHA-256.' }

$name = 'WattIz CPU Reader'
$oldTask = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($oldTask -and $oldTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $name }
Expand-Archive -LiteralPath $zip -DestinationPath $library -Force
Remove-Item -LiteralPath $zip
$source = Join-Path $PSScriptRoot 'cpu-reader.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe = Join-Path $library 'WattIzCpuReader.exe'
$dll = Join-Path $library 'LibreHardwareMonitorLib.dll'
& $compiler /nologo /optimize+ /target:exe /platform:x64 "/out:$exe" "/reference:$dll" $source
if ($LASTEXITCODE -ne 0) { throw 'CPU reader compilation failed.' }
$output = Join-Path $data 'cpu.json'
& $exe $output --once
if ($LASTEXITCODE -ne 0) { throw 'CPU package power test failed.' }
Get-Content -LiteralPath $output

$action = New-ScheduledTaskAction -Execute $exe -Argument ('"' + $output + '"') -WorkingDirectory $library
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
