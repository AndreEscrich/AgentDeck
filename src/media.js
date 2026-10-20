// Images, videos and sounds in the chat.
//
// The window cannot read files on disk itself, so it loads them through the
// "media:" address scheme, for example media://file/?path=%2FUsers%2F…%2FGrass.png.
// The handler below only serves image, video and sound files.
//
// Chromium shows png, jpg, gif, webp, bmp and svg, and plays mp4, webm and
// most mov files. Unity also uses tga, psd, psb, exr and tif. Photoshop
// files (psd, psb) get a PNG preview made by the app (photoshop.js) on
// every system; on macOS the others are converted with the built-in `sips`
// tool. Previews are cached.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const CONVERT = new Set(['tga', 'psd', 'psb', 'exr', 'tif', 'tiff', 'hdr', 'heic']);
const PHOTOSHOP = new Set(['psd', 'psb']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
const AUDIO = new Set(['wav', 'mp3', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);
const VIDEO_TYPE = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg' };

// Folders that are never searched for new media: Unity's caches and build
// output, version control and packages.
const SKIP_DIRS = new Set(['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'node_modules', '.git', '.svn', 'UserSettings']);

function extensionOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function kindOf(file) {
  const ext = extensionOf(file);
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (IMAGE.has(ext) || CONVERT.has(ext)) return 'image';
  return null;
}

// A PNG preview of a format Chromium cannot show, made once per file version.
function convertedPreview(file, cacheDir) {
  const photoshop = PHOTOSHOP.has(extensionOf(file));
  if (process.platform !== 'darwin' && !photoshop) return Promise.resolve(null);
  let stat;
  try { stat = fs.statSync(file); } catch { return Promise.resolve(null); }
  const key = crypto.createHash('sha1').update(`${file}|${stat.mtimeMs}|${stat.size}`).digest('hex');
  const out = path.join(cacheDir, key + '.png');
  if (fs.existsSync(out)) return Promise.resolve(out);
  fs.mkdirSync(cacheDir, { recursive: true });
  if (photoshop) {
    // A file with only its small JPEG preview is cached as .jpg.
    const jpg = out.replace(/\.png$/, '.jpg');
    if (fs.existsSync(jpg)) return Promise.resolve(jpg);
    const picture = require('./photoshop').preview(file);
    if (!picture) return Promise.resolve(null);
    const target = picture.type === 'image/jpeg' ? jpg : out;
    try { fs.writeFileSync(target, picture.data); } catch { return Promise.resolve(null); }
    return Promise.resolve(target);
  }
  return new Promise(resolve => {
    execFile('sips', ['-s', 'format', 'png', '--resampleHeightWidthMax', '2048', file, '--out', out], { timeout: 30000 },
      err => resolve(err || !fs.existsSync(out) ? null : out));
  });
}

// Serves media://file/?path=<absolute path> to the window.
function registerProtocol(protocol, net, cacheDir) {
  protocol.handle('media', async request => {
    const file = new URL(request.url).searchParams.get('path') || '';
    const kind = kindOf(file);
    if (!kind || !path.isAbsolute(file) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    let source = file;
    if (CONVERT.has(extensionOf(file))) {
      source = await convertedPreview(file, cacheDir);
      if (!source) return new Response('This format cannot be shown here', { status: 415 });
    }
    if (kind === 'video' || kind === 'audio') return videoResponse(source, request.headers.get('range'));
    return net.fetch(pathToFileURL(source).toString());
  });
}

// A video player jumps to a point in the clip by asking for that part of the
// file ("Range: bytes=1000-"). A file:// fetch ignores that and sends the
// whole file, so the player cannot seek and keeps playing. This answers with
// exactly the bytes asked for (status 206).
function videoResponse(file, rangeHeader) {
  let size;
  try { size = fs.statSync(file).size; } catch { return new Response('Not found', { status: 404 }); }
  const headers = { 'Content-Type': VIDEO_TYPE[extensionOf(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!m || (!m[1] && !m[2])) {
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  }
  // "bytes=-500" means the last 500 bytes.
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
  });
}

// Image and video files in cwd (and its subfolders) that were created or
// changed after sinceMs. Stops after maxFiles results or limitMs of searching.
async function recentMedia(cwd, sinceMs, { maxFiles = 40, limitMs = 4000 } = {}) {
  const found = [];
  const started = Date.now();
  const queue = [cwd];
  while (queue.length && found.length < maxFiles && Date.now() - started < limitMs) {
    const dir = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
      } else if (entry.isFile() && kindOf(entry.name)) {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.mtimeMs >= sinceMs) found.push({ path: full, kind: kindOf(entry.name), size: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* deleted in the meantime */ }
      }
    }
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// An image as it was before a task, for the before/after view: from the
// task's git snapshot (snap.base, see git.js), or else the last committed
// version in SVN. Written to cacheDir; resolves with its path, or null when
// there is no earlier version (a new file) or it is the same as now.
function run(cmd, args, cwd) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, encoding: 'buffer', maxBuffer: 200 * 1024 * 1024, timeout: 30000, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

async function mediaBefore(cwd, file, snap, cacheDir) {
  if (kindOf(file) !== 'image' || !path.isAbsolute(file)) return null;
  let before = null;
  if (snap?.kind === 'git' && snap.base) {
    const rel = path.relative(cwd, file).replace(/\\/g, '/');
    before = await run('git', ['show', `${snap.base}:./${rel}`], cwd);
  }
  if (!before) before = await run('svn', ['cat', file], cwd);
  if (!before || !before.length) return null;
  try {
    const now = fs.readFileSync(file);
    if (now.equals(before)) return null;
  } catch { /* gone: the old one is still worth showing */ }
  const key = crypto.createHash('sha1').update(before).digest('hex').slice(0, 20);
  const out = path.join(cacheDir, `before-${key}.${extensionOf(file)}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(out)) fs.writeFileSync(out, before);
  return out;
}

// A media file the chat names without saying where it is (an agent wrote
// "![A](Sound_A.mp4)" while the file is in a subfolder): the newest file of
// that name in cwd or its subfolders, or null. Stops after limitMs.
async function findMedia(cwd, name, { limitMs = 4000 } = {}) {
  const want = String(name || '').toLowerCase();
  if (!cwd || !want || !kindOf(want)) return null;
  const started = Date.now();
  const queue = [cwd];
  let best = null;
  while (queue.length && Date.now() - started < limitMs) {
    const dir = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === want) {
        try {
          const stat = await fs.promises.stat(full);
          if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
        } catch { /* deleted in the meantime */ }
      }
    }
  }
  return best ? best.path : null;
}

module.exports = { registerProtocol, recentMedia, kindOf, mediaBefore, findMedia };
