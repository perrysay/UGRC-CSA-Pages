# Run the repository's GNU Make targets using native Windows tools.
param([Parameter(Position=0, ValueFromRemainingArguments=$true)][string[]]$Targets = @('dm-preview'))
$ErrorActionPreference = 'Stop'
$rubyRoot = @('C:\Ruby32-x64', 'C:\Ruby33-x64', 'C:\Ruby34-x64') | Where-Object { Test-Path "$_\msys64\usr\bin\make.exe" } | Select-Object -First 1
if ($rubyRoot) { $env:PATH = "$rubyRoot\bin;$rubyRoot\msys64\usr\bin;" + $env:PATH }
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    $jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -ErrorAction SilentlyContinue | Where-Object Name -Like 'jdk-21*' | Select-Object -First 1
    if ($jdk) { $env:JAVA_HOME = $jdk.FullName; $env:PATH = "$($jdk.FullName)\bin;" + $env:PATH }
}
$pythonInstall = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python" -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path "$($_.FullName)\python.exe" } | Select-Object -First 1
if ($pythonInstall) { $env:DM_PYTHON = ($pythonInstall.FullName + '\python.exe').Replace('\', '/') }
$env:PYTHONUTF8 = '1'
Push-Location (Split-Path $PSScriptRoot -Parent)
try { $ErrorActionPreference = 'Continue'; & make @Targets; $result = $LASTEXITCODE }
finally { Pop-Location }
exit $result
