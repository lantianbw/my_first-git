// DSH Web 端口发现：netstat 枚举回环监听端口 + HTTP 指纹验证。
//
// 与 qq-hotswitch/lib/DshPort.ps1 同一套判据（本机 DSH 0.2.1 实测指纹）：
//   401 + 正文含 "dsh web authentication required" → http-401-auth-challenge（未登录常态）
//   200 + 正文含 __DSH_BOOT__ → http-200-boot-graph
//   200 + text/html + <title>DeepSeek Harness → http-200-web-title
// 该指纹在本机唯一，能排除 dsh-pet(8740) 等名字相近的服务。
//
// 存在的原因：DSH 每次启动把 webServer 绑到随机回环端口；bridge 的 baseUrl 只在启动时读一次，
// bridge 存活期间 DSH 换端口就再也连不上（2026-10-24 交接已知问题 #1）。bridge 用本模块做
// 「当前端口连续探测失败 → 扫描 → 热切换」，纯逻辑与系统调用都收在这里，便于离线测试。
//
// 系统调用（netstat / fetch）通过依赖注入，测试里换成桩；缺省绑真实实现。
import { execFile as execFileCb } from 'node:child_process';

function defaultExecFile(cmd, args, opts, cb) {
  execFileCb(cmd, args, opts, cb);
}

export const DSH_AUTH_BODY_PATTERN = /dsh web authentication required/i;
export const DSH_BOOT_MARKER = '__DSH_BOOT__';
export const DSH_TITLE_PATTERN = /<title>\s*DeepSeek Harness/i;

/** 判断一次 HTTP 探测结果是否来自 DSH web 服务（与 PowerShell 版 Test-DshWebResponse 同义）。 */
export function isDshWebResponse({ ok, statusCode, contentType, body } = {}) {
  if (!ok) return { isDsh: false, evidence: 'network-error' };
  const text = String(body ?? '');
  const status = Number(statusCode);
  if (status === 401 && DSH_AUTH_BODY_PATTERN.test(text)) return { isDsh: true, evidence: 'http-401-auth-challenge' };
  if (status === 200 && text.includes(DSH_BOOT_MARKER)) return { isDsh: true, evidence: 'http-200-boot-graph' };
  if (status === 200 && /text\/html/i.test(String(contentType ?? '')) && DSH_TITLE_PATTERN.test(text)) {
    return { isDsh: true, evidence: 'http-200-web-title' };
  }
  return { isDsh: false, evidence: `http-${Number.isFinite(status) ? status : 0}-not-dsh` };
}

const LOCAL_ADDR = /^(?:\[(?<v6>::1|::)\]|(?<v4>0\.0\.0\.0|127\.0\.0\.1)):(?<port>\d+)$/;

/**
 * 解析 `netstat -ano -p TCP` 输出中的回环 LISTENING 行。
 * 同一端口同时绑 0.0.0.0 与 [::] 时按端口去重，优先 127.0.0.1 探测（与 PS 版一致）。
 */
export function parseNetstatListeners(text, { minPort = 1024 } = {}) {
  const floor = Number.isFinite(minPort) ? Math.max(1, Math.round(minPort)) : 1024;
  const byPort = new Map();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    if (!rawLine.includes('LISTENING')) continue;
    const fields = rawLine.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const matched = LOCAL_ADDR.exec(fields[1] ?? '');
    if (!matched) continue;
    const port = Number(matched.groups.port);
    if (!Number.isFinite(port) || port < floor) continue;
    // 去重优先级看**原始绑定**：127.0.0.1 > [::1] > 0.0.0.0/[::]（与 PS 版一致）。
    // 0.0.0.0 / [::] 是通配绑定，探测时用 127.0.0.1 即可。
    const rank = matched.groups.v4 === '127.0.0.1' ? 0 : matched.groups.v6 === '::1' ? 1 : 2;
    const probeHost = rank === 1 ? '[::1]' : '127.0.0.1';
    const pid = Number(fields[fields.length - 1]);
    const prev = byPort.get(port);
    const prevRank = prev ? prev.rank : 9;
    if (!prev || rank < prevRank) {
      byPort.set(port, { port, probeHost, bind: fields[1], pid: Number.isFinite(pid) ? pid : 0, rank });
    }
  }
  return [...byPort.values()].map(({ rank, ...rest }) => rest).sort((a, b) => a.port - b.port);
}

/**
 * 建一个端口扫描器。execFile / fetchImpl 可注入（测试换桩）；缺省绑真实实现。
 * 探测只发 GET /（未登录态的 401 挑战正是指纹），只打回环地址。
 */
export function createDshPortScanner({
  execFile = defaultExecFile,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  timeoutMs = 700,
  minPort = 1024,
  concurrency = 8
} = {}) {
  const doExec = typeof execFile === 'function' ? execFile : null;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : null;

  async function rawProbe(host, port) {
    if (!doFetch) return { ok: false };
    const url = `http://${host}:${port}/`;
    try {
      const res = await doFetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': 'dsh-port-resolver/1.0' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await res.text();
      return { ok: true, statusCode: res.status, contentType: res.headers.get('content-type') ?? '', body };
    } catch {
      return { ok: false };
    }
  }

  /** 探测单个端口是否是 DSH。host 接受 127.0.0.1 / [::1]。 */
  async function probePort(port, host = '127.0.0.1') {
    const numeric = Number(port);
    if (!Number.isFinite(numeric) || numeric <= 0) return { isDsh: false, evidence: 'bad-port' };
    const raw = await rawProbe(String(host || '127.0.0.1'), numeric);
    return { port: numeric, ...isDshWebResponse(raw) };
  }

  /** 有限并发地跑完全部任务。 */
  async function runLimited(items, worker) {
    const results = new Array(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(lanes);
    return results;
  }

  /**
   * 全量发现：hint 端口先探（仍要指纹验证），再 netstat 枚举 + 指纹扫描。
   * excludePorts 里的端口跳过（通常是「刚探测失败的那个旧端口」——重探它没有意义，
   * 但 hint 命中时仍会写缓存，供下次直连）。
   */
  async function discover({ excludePorts = [], hintPorts = [] } = {}) {
    const startedAt = Date.now();
    const exclude = new Set((Array.isArray(excludePorts) ? excludePorts : []).map(Number));
    const hints = [...new Set((Array.isArray(hintPorts) ? hintPorts : []).map(Number))]
      .filter((port) => Number.isFinite(port) && port > 0);
    let probed = 0;

    for (const port of hints) {
      probed += 1;
      const verdict = await probePort(port);
      if (verdict.isDsh) {
        return { found: true, port, baseUrl: `http://127.0.0.1:${port}`, evidence: `hint:${verdict.evidence}`, probed, scanned: 0, elapsedMs: Date.now() - startedAt, hits: [verdict] };
      }
    }

    if (!doExec) return { found: false, port: 0, baseUrl: '', evidence: 'no-exec', probed, scanned: 0, elapsedMs: Date.now() - startedAt, hits: [] };
    let text = '';
    try {
      text = await new Promise((resolve, reject) => {
        doExec('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
          if (error) reject(error); else resolve(String(stdout ?? ''));
        });
      });
    } catch {
      return { found: false, port: 0, baseUrl: '', evidence: 'netstat-failed', probed, scanned: 0, elapsedMs: Date.now() - startedAt, hits: [] };
    }

    const listeners = parseNetstatListeners(text, { minPort }).filter((item) => !exclude.has(item.port));
    const verdicts = await runLimited(listeners, (item) => probePort(item.port, item.probeHost));
    const hits = verdicts.filter((v) => v.isDsh).sort((a, b) => a.port - b.port);
    return {
      found: hits.length > 0,
      port: hits.length ? hits[0].port : 0,
      baseUrl: hits.length ? `http://127.0.0.1:${hits[0].port}` : '',
      evidence: hits.length ? hits[0].evidence : 'no-dsh-listener',
      probed: probed + listeners.length,
      scanned: listeners.length,
      elapsedMs: Date.now() - startedAt,
      hits
    };
  }

  return { probePort, discover };
}
