import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};

export const contentType = (f) => TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';

/** Anything that is not a page, markdown or an image is shown as plain text. */
export const kindOf = (f) => {
  const e = path.extname(f).toLowerCase();
  if (e === '.html' || e === '.htm') return 'html';
  if (e === '.md' || e === '.markdown') return 'markdown';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'].includes(e)) return 'image';
  return 'text';
};

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Request path segments arrive percent-encoded and files on disk are not. Null if malformed. */
export function decodeSegments(parts) {
  try {
    return parts.map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

/** Resolve a request path under root, refusing anything that escapes it. */
export function safeJoin(root, rel) {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + (rel || '')));
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

export function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readIfFile(file) {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}
