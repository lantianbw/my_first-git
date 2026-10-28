# Deploy qq-bridge to the cloud server.
#
# Why upload the whole src directory: bridge.js imports change with every refactor,
# and uploading only changed files repeatedly missed new modules
# (three ERR_MODULE_NOT_FOUND incidents on 2026-10-28). src is only a few MB.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
#
# NOTE: keep this file ASCII-only. powershell -File parses UTF-8 (no BOM) as the
# system ANSI codepage; non-ASCII text breaks quoting.
$ErrorActionPreference = 'Stop'

$target = 'root@175.178.200.118'
$remote = '/opt/qq-bridge'

Write-Host '[1/5] ensure remote dirs'
ssh $target "mkdir -p $remote/src/guards $remote/src/content $remote/src/cost $remote/src/tools $remote/src/persist $remote/src/inbound $remote/src/obs $remote/src/scheduler $remote/src/observability $remote/src/auth $remote/src/session $remote/src/outbound $remote/src/heal $remote/src/lifecycle"

Write-Host '[2/5] backup remote bridge.js (keep newest 3)'
ssh $target "cd $remote && cp -p src/bridge.js src/bridge.js.bak-deploy-`$(date +%Y%m%d-%H%M%S) && ls -1t src/bridge.js.bak-* | tail -n +4 | xargs -r rm -f"

Write-Host '[3/5] upload src directory'
scp -r .\src\ "${target}:${remote}/"

Write-Host '[4/5] syntax check'
$check = ssh $target "cd $remote && node --check src/bridge.js && node --check src/mcp-snowluma-safe.js && echo ALL_SYNTAX_OK"
Write-Host $check
if ($check -notmatch 'ALL_SYNTAX_OK') { throw 'syntax check failed, server NOT restarted' }

Write-Host '[5/5] restart and verify'
ssh $target "cd $remote && systemctl restart qq-bridge && sleep 12 && systemctl is-active qq-bridge && echo ---last-log--- && tail -4 /root/dsh-run/bridge.log"
