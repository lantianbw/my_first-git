// 保存到本地的文件名整形（纯函数，便于离线回归）。
//
// 只做「文件名」层面的约束：去掉目录分隔符、保留字符、控制字符与开头的点，
// 最终写入目录由调用方固定（images/ 或 files/），因此不会出现路径穿越。
import path from 'node:path';

/** 允许的图片扩展名 → 规范后缀。 */
export function extFromMime(mimeType) {
  const type = String(mimeType ?? '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return '';
}

/**
 * 清洗保存文件名：
 * - 只取 basename，去掉 ../ 与目录分隔符
 * - 去掉 Windows 非法字符与控制字符
 * - 去掉开头连续的点（避免隐藏文件 / ..）
 * - 截到 80 字符；空名用 fallback
 */
export function sanitizeSaveName(name, fallback = '') {
  const raw = String(name ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  const base = path.basename(raw).replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim();
  const safe = base.slice(0, 80);
  return safe || String(fallback ?? '').slice(0, 80);
}

/** 给没有扩展名的文件名补后缀。 */
export function ensureExt(name, ext) {
  const value = String(name ?? '');
  if (!value) return value;
  if (/\.[a-z0-9]{2,5}$/i.test(value)) return value;
  return ext ? `${value}.${ext}` : value;
}

/**
 * 保存图片专用：扩展名必须是图片格式，否则按真实 mime 改掉。
 * 例如 name="config.json" + ext="jpg" → "config.jpg"（避免存出一个叫 .json 的图片）。
 */
export function ensureImageExt(name, ext) {
  const value = String(name ?? '');
  if (!value) return value;
  if (/\.(jpe?g|png|webp|gif)$/i.test(value)) return value;
  const stripped = value.replace(/\.[a-z0-9]{1,8}$/i, '');
  return `${stripped}.${ext || 'jpg'}`;
}
