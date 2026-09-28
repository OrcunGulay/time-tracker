<#
.SYNOPSIS
    Windows'ta agent'i oturum acilisinda otomatik baslatan gorevi kaydeder.

.NOTES
    Ekran goruntusu ve aktif pencere tespiti kullanicinin etkilesimli
    oturumunda calismayi gerektirdigi icin "oturum acilinda" tetikleyicisi
    kullanilir. Gercek bir Windows servisi (Session 0) gerekiyorsa NSSM ile
    "Interactive" servis olarak kurulmalidir.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1 `
        -PythonPath "C:\tt-agent\.venv\Scripts\python.exe" `
        -AgentPath  "C:\tt-agent" `
        -ConfigPath "C:\tt-agent\config.yaml"
#>
param(
    [Parameter(Mandatory = $true)][string]$PythonPath,
    [Parameter(Mandatory = $true)][string]$AgentPath,
    [Parameter(Mandatory = $false)][string]$ConfigPath = "$AgentPath\config.yaml",
    [Parameter(Mandatory = $false)][string]$TaskName = "TimetrackerAgent"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PythonPath)) { throw "Python bulunamadi: $PythonPath" }
if (-not (Test-Path $AgentPath)) { throw "Agent dizini bulunamadi: $AgentPath" }

$action = New-ScheduledTaskAction `
    -Execute $PythonPath `
    -Argument "-m tt_agent --mode silent --config `"$ConfigPath`"" `
    -WorkingDirectory $AgentPath

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Zaman Takip Desktop Agent (aktivite + ekran goruntusu)" `
    -Force | Out-Null

Write-Host "Gorev kaydedildi: $TaskName"
Write-Host "Baslatmak icin : Start-ScheduledTask -TaskName $TaskName"
Write-Host "Durum         : Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
