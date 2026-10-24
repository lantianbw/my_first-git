// 本地发图的路径解析与约束（纯函数，便于离线回归）。
//
// 为什么单独抽出来：路径穿越（../）、格式、大小这三类校验如果在 HTTP handler 里
// 直接写，测试就得拉起整个 bridge；抽成纯函数后可以用临时目录直接验证。
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;

/**
 * 把相对路径解析到 images/ 目录内，并做格式/存在性/大小校验。
 * @returns {{ok:true, abs:string, size:number, uri:string} | {ok:false, status:number, error:string}}
 */
export function resolveImageFile({ root, dir = 'images', file, maxBytes = 5_242_880 } = {}) {
  const raw = String(file ?? '').trim();
  if (!raw) return { ok: false, status: 400, error: 'file 不能为空' };
  const baseDir = path.resolve(String(root ?? ''), String(dir || 'images'));
  const abs = path.resolve(baseDir, raw);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) {
    return { ok: false, status: 403, error: `只允许发送 ${dir}/ 目录内的文件` };
  }
  if (!IMAGE_EXT_RE.test(abs)) {
    return { ok: false, status: 400, error: '只支持 jpg/png/webp/gif' };
  }
  let stat = null;
  try { stat = fs.statSync(abs); } catch {}
  if (!stat || !stat.isFile()) {
    return { ok: false, status: 404, error: `文件不存在：${raw}` };
  }
  const limit = Math.max(1, Number(maxBytes) || 5_242_880);
  if (stat.size > limit) {
    return { ok: false, status: 400, error: `图片过大（${stat.size} 字节，上限 ${limit}）` };
  }
  return { ok: true, abs, size: stat.size, uri: `file:///${abs.replace(/\\/g, '/')}` };
}
