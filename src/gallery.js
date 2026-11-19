// The Gallery (renderer/gallery.js): the art library of a game, a Google
// Drive folder whose subfolders are the categories ("Game headers", "Game
// backgrounds", ...). Settings → Gallery has the folder's Drive link.
//
// The app reads the folder from disk, through Google Drive for desktop, so
// it needs no Google sign-in of its own. To find the folder on disk, the
// app asks the Drive connector (readDrivePath in agents.js) for the names of
// the folder and the folders above it, and looks for that path in each
// Google Drive that Drive for desktop shows:
//   macOS:   ~/Library/CloudStorage/GoogleDrive-<account>/Shared drives/<drive>/<folders>
//   Windows: <letter>:\Shared drives\<drive>\<folders> (G: by default)
// A shared drive's folder is under "Shared drives", a folder of your own
// under "My Drive". The names are kept in gallery.json, so this asks Drive
// once per link. Settings → Gallery → Folder on this computer skips all of
// this when you pick the folder yourself.

const fs = require('fs');
const os = require('os');
const path = require('path');

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const MAX_IMAGES = 3000;
const MAX_DEPTH = 4;

// The folder id of a Drive link (…/folders/<id>, ?id=<id>), or the id itself.
function folderId(link) {
  const s = String(link || '').trim();
  return /\/folders\/([\w-]{10,})/.exec(s)?.[1] || /[?&]id=([\w-]{10,})/.exec(s)?.[1] || (/^[\w-]{10,}$/.test(s) ? s : null);
}

// The folders where Drive for desktop shows each signed-in account's files.
function driveRoots() {
  const roots = [];
  if (process.platform === 'darwin') {
    const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
    try { for (const d of fs.readdirSync(cloud)) if (d.startsWith('GoogleDrive')) roots.push(path.join(cloud, d)); } catch { /* none */ }
    // Older versions of Drive for desktop: a disk of their own.
    try { for (const d of fs.readdirSync('/Volumes')) if (/^GoogleDrive/.test(d)) roots.push(path.join('/Volumes', d)); } catch { /* none */ }
  } else if (process.platform === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      try { if (fs.existsSync(path.join(root, 'My Drive')) || fs.existsSync(path.join(root, 'Shared drives'))) roots.push(root); } catch { /* not there */ }
    }
  }
  return roots;
}

// Where a folder is on this computer, from its place in Drive:
// { drive: shared drive name or null, folders: [names from the top down] }.
function localPathOf(place) {
  if (!place?.folders?.length) return null;
  for (const root of driveRoots()) {
    const p = place.drive
      ? path.join(root, 'Shared drives', place.drive, ...place.folders)
      : path.join(root, 'My Drive', ...place.folders);
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* not in this account */ }
  }
  return null;
}

let store = null;   // { places: { folderId: { drive, folders, at } } }
let storeFile = null;
let askDrive = null;   // folderId -> Promise<{ drive, folders } | null>
const asking = new Map();

function setup(userData, readPlace) {
  storeFile = path.join(userData, 'gallery.json');
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { store = {}; }
  store.places ||= {};
  askDrive = readPlace;
}

function save() {
  try { fs.writeFileSync(storeFile, JSON.stringify(store, null, 2)); } catch { /* next time */ }
}

// The gallery's folder on disk: { folder } or { error, place? }.
// config.galleryFolder (picked by hand) wins over the Drive link.
async function locate(config, { again = false } = {}) {
  const picked = String(config.galleryFolder || '').trim();
  if (picked) {
    try { if (fs.statSync(picked).isDirectory()) return { folder: picked }; } catch { /* gone */ }
    return { error: `The folder ${picked} is not on this computer. Pick it again in Settings → Gallery.` };
  }
  const id = folderId(config.galleryUrl);
  if (!id) return { error: 'No gallery yet. Paste the Drive link of the art folder in Settings → Gallery.' };
  if (!driveRoots().length) return { error: 'Google Drive for desktop is not on this computer, or it is not signed in. Install it, or pick the folder in Settings → Gallery → Folder on this computer.' };
  let place = !again && store.places[id];
  if (!place) {
    if (!asking.has(id)) asking.set(id, Promise.resolve(askDrive?.(id)).catch(() => null).finally(() => asking.delete(id)));
    place = await asking.get(id);
    if (!place?.folders?.length) return { error: 'Could not read the folder from Google Drive. Check that the Google Drive connector is connected (Connectors) and that you can open the link.' };
    store.places[id] = { ...place, at: Date.now() };
    save();
  }
  const folder = localPathOf(place);
  if (folder) return { folder, place };
  const where = [place.drive ? `Shared drives/${place.drive}` : 'My Drive', ...place.folders].join('/');
  return { error: `Drive for desktop does not show ${where} on this computer. Check that you are signed in with an account that can open it.`, place };
}

// The images in the gallery: { folder, categories: [{ name, images: [{ path, name, sub, size, mtime }] }] }.
// Each folder at the top is a category; images in deeper folders belong to
// their top folder, with the folders between in sub. Images at the top go
// into a category with no name.
function list(folder) {
  const categories = new Map();
  let count = 0;
  const walk = (dir, depth, category, sub) => {
    if (count >= MAX_IMAGES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(p, depth + 1, depth === 0 ? e.name : category, depth === 0 ? [] : [...sub, e.name]);
      } else if (IMAGE.test(e.name) && count < MAX_IMAGES) {
        let stat;
        try { stat = fs.statSync(p); } catch { continue; }
        const key = category || '';
        if (!categories.has(key)) categories.set(key, []);
        categories.get(key).push({ path: p, name: e.name, sub: sub.join('/'), size: stat.size, mtime: stat.mtimeMs });
        count++;
      }
    }
    // A category folder with no images still shows (an empty one to fill).
    if (depth === 1 && !categories.has(category)) categories.set(category, []);
  };
  walk(folder, 0, '', []);
  const named = [...categories.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out = named.map(name => ({ name, images: categories.get(name) }));
  if (categories.has('')) out.push({ name: '', images: categories.get('') });
  return { folder, categories: out, truncated: count >= MAX_IMAGES };
}

// The gallery's folder without asking Drive: the folder picked by hand, or
// the one found from the link before (gallery.json). Null when not known yet.
function knownFolder(config) {
  const picked = String(config.galleryFolder || '').trim();
  if (picked) { try { return fs.statSync(picked).isDirectory() ? picked : null; } catch { return null; } }
  const id = folderId(config.galleryUrl);
  return id && store?.places[id] ? localPathOf(store.places[id]) : null;
}

// What agents are told about the gallery (added to their system prompt).
function galleryPrompt(config) {
  const folder = knownFolder(config);
  if (!folder) return '';
  let cats = [];
  try { cats = fs.readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch { return ''; }
  return [
    `The team's art library (the Gallery in Agent Hub) is the folder ${folder}.`,
    cats.length ? `Each folder in it is a category: ${cats.join(', ')}.` : '',
    'When the user asks you to make or find art (a header, a background, an icon...), look there first: pick the images that fit the request as references, open them to check that they fit, and name the ones you used.',
    'Images the user attached with the path of a file in that folder are references the user picked: use those first.',
    'If the Tactile Create Art tools are available, make the new art with Create Art and those images as references, then save the result where the user asked (ask when it is not clear). Without Create Art, say that you cannot make new art, and show the closest images from the library instead.',
    'Never change or delete the files in the library unless the user asks.',
  ].filter(Boolean).join(' ');
}

// A folder name you typed: one level, no path, nothing Drive or the
// system refuses.
function cleanName(name) {
  const n = String(name || '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return n && n !== '.' && n !== '..' && n.length <= 120 ? n : null;
}

// A category's folder inside the gallery (an existing one, or the gallery
// itself for ''), never a path outside it.
function categoryDir(folder, category) {
  if (!category) return folder;
  const name = cleanName(category);
  if (!name || name !== category) return null;
  const dir = path.join(folder, name);
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

// A new category: a folder in the gallery. Drive for desktop uploads it.
function makeFolder(folder, name) {
  const n = cleanName(name);
  if (!n) return { error: 'Type a name without / \\ : * ? " < > |.' };
  const dir = path.join(folder, n);
  if (fs.existsSync(dir)) return { error: `${n} is already there.` };
  try { fs.mkdirSync(dir); } catch (err) { return { error: `Could not make the folder: ${err.message}` }; }
  return { name: n };
}

// Copies images into a category; a name that is taken gets " 2", " 3"...
function addImages(folder, category, files) {
  const dir = categoryDir(folder, category);
  if (!dir) return { error: `The folder ${category} is not in the gallery any more.` };
  const added = [];
  const skipped = [];
  for (const file of files || []) {
    if (typeof file !== 'string' || !IMAGE.test(file)) { skipped.push(path.basename(String(file))); continue; }
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    let target = path.join(dir, base + ext);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${base} ${i}${ext}`);
    try { fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL); added.push(target); } catch { skipped.push(path.basename(file)); }
  }
  return { added, skipped };
}

// Tells onChange when something in the gallery's folder changed (Drive
// brought new files, or you added some), at most twice a second.
let watcher = null;
let watching = null;
function watch(folder, onChange) {
  if (watching === folder) return;
  watcher?.close();
  watcher = null;
  watching = folder;
  let timer = null;
  try {
    watcher = fs.watch(folder, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 500);
    });
    watcher.on('error', () => { watcher?.close(); watcher = null; watching = null; });
  } catch { watching = null; }
}

module.exports = { setup, locate, list, folderId, knownFolder, galleryPrompt, makeFolder, addImages, watch };
