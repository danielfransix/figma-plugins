param(
    [string]$ProtoPiePath = "$env:LOCALAPPDATA\Programs\ProtoPie\ProtoPie.exe",
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProtoPiePath -PathType Leaf)) {
    throw "ProtoPie was not found at '$ProtoPiePath'. Pass -ProtoPiePath with its installed executable path."
}
$resolvedExecutable = (Resolve-Path -LiteralPath $ProtoPiePath).Path
if ($Check) {
    Write-Output "Launcher ready: $resolvedExecutable"
    Write-Output 'No application was launched and no environment setting was changed.'
    exit 0
}

if (Get-Process -Name ProtoPie -ErrorAction SilentlyContinue) {
    throw 'Save your open Pies and quit ProtoPie, then run this launcher again. An already-running app cannot inherit the setting.'
}

Write-Output 'Starting ProtoPie with automatic approval for ALL local Studio MCP clients.'
Write-Output 'This is an undocumented ProtoPie setting. Launch ProtoPie normally to return to manual approval.'
$previousValue = [Environment]::GetEnvironmentVariable('PROTOPIE_MCP_AUTO_APPROVE', 'Process')
try {
    [Environment]::SetEnvironmentVariable('PROTOPIE_MCP_AUTO_APPROVE', '1', 'Process')
    Start-Process -FilePath $resolvedExecutable
} finally {
    [Environment]::SetEnvironmentVariable('PROTOPIE_MCP_AUTO_APPROVE', $previousValue, 'Process')
}
