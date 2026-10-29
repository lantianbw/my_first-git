# deploy.ps1 — 一条命令部署 qq-bridge：对账 → 备份 → 上传差异 → 重启 → 回读校验（失败自动回滚）
#
# 为什么要"对账"：2026-10-29 曾只传"改过的文件"，漏了 bridge.js 新 import 的 outbound/send.js，
# 线上 ERR_MODULE_NOT_FOUND 重启循环约 2 分钟。所以部署前必须先把本地 src 与远端 src 对齐。
#
# 用法：
#   .\scripts\deploy.ps1              # 跑单测 → 对账 → 备份 → 上传 → 重启 → 校验
#   .\scripts\deploy.ps1 -SkipTests   # 跳过单测（紧急时用，不推荐）
#   .\scripts\deploy.ps1 -DryRun      # 只对账，不上传不重启
#
# 只上传 src/ 下的 js 文件；tests/ 与 scripts/ 不上线。

param(
  [switch]$SkipTests,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$hostName = 'root@175.178.200.118'
$remoteRoot = '/opt/qq-bridge'
$nodeExe = 'C:\Users\18439\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

function Invoke-Remote([string]$cmd) { return (ssh $hostName $cmd) }

# ── 1. 本地单测 ───────────────────────────────────────────────────────────────
if (-not $SkipTests) {
  Write-Host '[1/6] 本地单测...'
  $out = & $nodeExe --test tests/*.test.mjs 2>&1
  $summary = $out | Select-String -Pattern '^ℹ (tests|pass|fail)'
  if (($out -join "`n") -match 'fail [1-9]') {
    $summary | ForEach-Object { Write-Host $_ }
    throw '单测未通过，拒绝部署。'
  }
  $summary | ForEach-Object { Write-Host "      $_" }
} else {
  Write-Host '[1/6] 单测已跳过（-SkipTests）'
}

# ── 2. 文件对账（本地 vs 远端 md5）────────────────────────────────────────────
Write-Host '[2/6] 对账本地 / 远端 src...'
$localFiles = Get-ChildItem (Join-Path $root 'src') -Recurse -File -Filter *.js
$localMap = @{}
foreach ($f in $localFiles) {
  $rel = $f.FullName.Substring((Join-Path $root 'src').Length + 1).Replace('\', '/')
  $localMap[$rel] = (Get-FileHash $f.FullName -Algorithm MD5).Hash.ToLower()
}

$remoteLines = Invoke-Remote 'cd /opt/qq-bridge/src && find . -type f -exec md5sum {} +'
$remoteMap = @{}
foreach ($line in $remoteLines) {
  # 只对账"真正的模块文件"：远端还留有大量 .bak-* 备份与 .mjs，参与对账只会制造噪音。
  if ($line -match '^([0-9a-f]{32})\s+\./(.+\.js)$') {
    if ($Matches[2] -notmatch '\.bak') { $remoteMap[$Matches[2]] = $Matches[1] }
  }
}

$toUpload = @()
foreach ($rel in $localMap.Keys) {
  if (-not $remoteMap.ContainsKey($rel)) { $toUpload += [pscustomobject]@{ File = $rel; Why = '远端缺失' } }
  elseif ($remoteMap[$rel] -ne $localMap[$rel]) { $toUpload += [pscustomobject]@{ File = $rel; Why = '内容不同' } }
}
$extraRemote = $remoteMap.Keys | Where-Object { -not $localMap.ContainsKey($_) }

Write-Host ("      本地 {0} / 远端 {1} / 需上传 {2} / 远端多出 {3}" -f $localMap.Count, $remoteMap.Count, $toUpload.Count, @($extraRemote).Count)
if (@($extraRemote).Count -gt 0) {
  Write-Host ('      远端多出（不自动删除，仅提示）：' + (@($extraRemote) -join ', ')) -ForegroundColor Yellow
}
if ($toUpload.Count -gt 0) { $toUpload | ForEach-Object { Write-Host ("      + {0}  ({1})" -f $_.File, $_.Why) } }
else { Write-Host '      无差异。' }

if ($DryRun) { Write-Host '[DryRun] 到此为止：不上传、不重启。'; exit 0 }

# ── 3. 备份远端 src ──────────────────────────────────────────────────────────
Write-Host '[3/6] 备份远端 src...'
$stamp = Get-Date -Format 'HHmmss'
$backupPath = "$remoteRoot/src.bak-$stamp"
Invoke-Remote "cp -a $remoteRoot/src $backupPath" | Out-Null
Write-Host "      $backupPath"

# ── 4. 上传差异 ──────────────────────────────────────────────────────────────
Write-Host '[4/6] 上传差异文件...'
foreach ($item in $toUpload) {
  $rel = $item.File
  $remoteDir = "$remoteRoot/src/" + (Split-Path $rel -Parent).Replace('\', '/')
  Invoke-Remote "mkdir -p $remoteDir" | Out-Null
  scp (Join-Path $root "src/$rel") "${hostName}:${remoteRoot}/src/$rel" | Out-Null
  Write-Host "      ↑ $rel"
}

# ── 5. 重启 ──────────────────────────────────────────────────────────────────
Write-Host '[5/6] 重启服务...'
Invoke-Remote 'systemctl restart qq-bridge' | Out-Null
Start-Sleep -Seconds 7

# ── 6. 回读校验（失败自动回滚）────────────────────────────────────────────────
Write-Host '[6/6] 校验...'
$state = (Invoke-Remote 'systemctl is-active qq-bridge').Trim()
if ($state -ne 'active') {
  Write-Host "      状态=$state，自动回滚到 $backupPath" -ForegroundColor Red
  Invoke-Remote "rm -rf $remoteRoot/src && cp -a $backupPath $remoteRoot/src && systemctl restart qq-bridge" | Out-Null
  Start-Sleep -Seconds 7
  $after = (Invoke-Remote 'systemctl is-active qq-bridge').Trim()
  Write-Host "      回滚后状态=$after" -ForegroundColor Yellow
  Write-Host '      最近日志：' -ForegroundColor Yellow
  Invoke-Remote 'tail -12 /root/dsh-run/bridge.log' | ForEach-Object { Write-Host "      $_" }
  exit 1
}

Write-Host '      状态=active' -ForegroundColor Green
Invoke-Remote 'tail -4 /root/dsh-run/bridge.log' | ForEach-Object { Write-Host "      $_" }
Write-Host "      回滚点：$backupPath" -ForegroundColor DarkGray
