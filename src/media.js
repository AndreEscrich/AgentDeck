// Images and videos in the chat.
//
// The window cannot read files on disk itself, so it loads them through the
// "media:" address scheme, for example media://file/?path=%2FUsers%2F…%2FGrass.png.
// The handler below only serves image and video files.
//
// Chromium shows png, jpg, gif, webp, bmp and svg, and plays mp4, webm and
// most mov files. Unity also uses tga, psd, exr and tif; on macOS those are
// converted to a PNG preview with the built-in `sips` tool and cached.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const CONVERT = new Set(['tga', 'psd', 'exr', 'tif', 'tiff', 'hdr', 'heic']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);

// Folders that are never searched for new media: Unity's caches and build
// output, version control and packages.
const SKIP_DIRS = new Set(['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'node_modules', '.git', '.svn', 'UserSettings']);

function extensionOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function kindOf(file) {
  const ext = extensionOf(file);
  if (VIDEO.has(ext)) return 'video';
  if (IMAGE.has(ext) || CONVERT.has(ext)) return 'image';
  return null;
}

// A PNG preview of a format Chromium cannot show, made once per file version.
function convertedPreview(file, cacheDir) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  let stat;
  try { stat = fs.statSync(file); } catch { return Promise.resolve(null); }
  const key = crypto.createHash('sha1').update(`${file}|${stat.mtimeMs}|${stat.size}`).digest('hex');
  const out = path.join(cacheDir, key + '.png');
  if (fs.existsSync(out)) return Promise.resolve(out);
  fs.mkdirSync(cacheDir, { recursive: true });
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
    // Passing the request's headers on keeps Range requests working, which
    // video players use to jump around in a file.
    return net.fetch(pathToFileURL(source).toString(), { headers: request.headers });
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

module.exports = { registerProtocol, recentMedia, kindOf };
