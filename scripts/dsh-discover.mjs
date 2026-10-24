#!/usr/bin/env node
// 手动跑一次 DSH Web 端口发现（netstat + HTTP 指纹），运维排查用。
//
// 用法：
//   node scripts/dsh-discover.mjs            # 全量扫描
//   node scripts/dsh-discover.mjs --probe 11883   # 只验证指定端口
//   node scripts/dsh-discover.mjs --json
import { createDshPortScanner } from '../src/dsh-port.js';

const args = new Map(process.argv.slice(2).map((item, index, all) => {
  if (!item.startsWith('--')) return [String(index), item];
  const [key, inline] = item.slice(2).split('=');
  if (inline !== undefined) return [key, inline];
  const next = all[index + 1];
  return next && !next.startsWith('--') ? [key, next] : [key, true];
}));

const scanner = createDshPortScanner();
const probePort = Number(args.get('probe')) || 0;

if (probePort > 0) {
  const verdict = await scanner.probePort(probePort);
  if (args.has('json')) console.log(JSON.stringify(verdict));
  else console.log(`端口 ${probePort}：${verdict.isDsh ? `是 DSH（${verdict.evidence}）` : `不是 DSH（${verdict.evidence}）`}`);
  process.exit(verdict.isDsh ? 0 : 1);
}

const found = await scanner.discover();
if (args.has('json')) console.log(JSON.stringify(found));
else {
  console.log(`found=${found.found} baseUrl=${found.baseUrl || '-'} evidence=${found.evidence}`
    + `（探测 ${found.probed} 个端口，其中扫描 ${found.scanned}，耗时 ${found.elapsedMs}ms）`);
  for (const hit of found.hits) console.log(`  命中：${hit.port}（${hit.evidence}）`);
}
process.exit(found.found ? 0 : 1);
