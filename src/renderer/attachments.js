// Images and videos you drop on (or paste into) the message box, for the
// agent to look at.
//
// Images go to Claude with your message, sized down to at most 1568 pixels on
// the longest side (the size Claude reads best). Claude cannot watch videos,
// so a video is sent as six frames spread over the clip, taken with the
// browser's own video decoder. The message also names each file's path, so
// the agent can work with the file itself.
//
// Each view (the Hub, every agent, every saved session) has its own list,
// like the text in the message box.

const MAX_SIDE = 1568;
const FRAME_SIDE = 1024;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?|tga|psd)$/i;
const VIDEO_FILE = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

function kindOfFile(file) {
  if (file.type.startsWith('image/') || IMAGE_FILE.test(file.name)) return 'image';
  if (file.type.startsWith('video/') || VIDEO_FILE.test(file.name)) return 'video';
  return null;
}

function formatClock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}${s < 10 ? '.' + Math.floor((s % 1) * 10) : ''}`;
}

// Draws a picture (an image or a video frame) into a canvas no larger than
// maxSide, and returns it as { mediaType, data (base64), url (for previews) }.
function encode(source, width, height, maxSide, keepAlpha) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const mediaType = keepAlpha ? 'image/png' : 'image/jpeg';
  const url = canvas.toDataURL(mediaType, 0.86);
  return { mediaType, data: url.slice(url.indexOf(',') + 1), url };
}

async function readImage(file) {
  const bitmap = await createImageBitmap(file);
  const keepAlpha = /png|webp|gif/i.test(file.type) || /\.(png|webp|gif|tga|psd)$/i.test(file.name);
  const picture = encode(bitmap, bitmap.width, bitmap.height, MAX_SIDE, keepAlpha);
  bitmap.close?.();
  return { images: [picture], thumb: picture.url };
}

// Six frames spread over the clip (three for clips under 3 seconds).
async function readVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('This video format cannot be read here.'));
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const count = duration < 3 ? 3 : 6;
    const images = [];
    const times = [];
    for (let i = 0; i < count; i++) {
      const t = duration ? (duration * (i + 0.5)) / count : 0;
      await new Promise(resolve => {
        video.onseeked = resolve;
        video.currentTime = t;
        if (!duration) resolve();
      });
      images.push(encode(video, video.videoWidth, video.videoHeight, FRAME_SIDE, false));
      times.push(t);
    }
    return { images, thumb: images[Math.floor(images.length / 2)]?.url, duration, times };
  } finally {
    URL.revokeObjectURL(url);
  }
}

class Attachments {
  // row: the element above the text box. key(): the current view's key.
  constructor(row, { key, onChange }) {
    this.row = row;
    this.key = key;
    this.onChange = onChange;
    this.lists = new Map();   // view key -> [attachment]
    this.nextId = 1;
  }

  current() {
    return this.lists.get(this.key()) || [];
  }

  // Adds dropped or pasted files to the current view. Files that are neither
  // an image nor a video are skipped (and named in the returned list).
  add(files) {
    const key = this.key();
    const list = this.lists.get(key) || [];
    const skipped = [];
    for (const file of files) {
      const kind = kindOfFile(file);
      if (!kind) { skipped.push(file.name); continue; }
      const item = { id: this.nextId++, kind, name: file.name || (kind === 'image' ? 'Pasted image' : 'Video'), path: window.deck.pathForFile?.(file) || null, images: [], thumb: null, ready: null };
      item.ready = (kind === 'image' ? readImage(file) : readVideo(file))
        .then(r => Object.assign(item, r))
        .catch(err => { item.error = err?.message || 'Could not read this file.'; })
        .finally(() => this.render());
      list.push(item);
    }
    this.lists.set(key, list);
    this.render();
    return skipped;
  }

  remove(id) {
    const key = this.key();
    this.lists.set(key, this.current().filter(a => a.id !== id));
    this.render();
  }

  // Takes the current view's attachments for sending: waits until all are
  // read, then returns { images, note } and empties the list. note is text
  // for the message that names each file (and the frame times of videos).
  async take() {
    const key = this.key();
    const list = this.lists.get(key) || [];
    this.lists.delete(key);
    this.render();
    await Promise.all(list.map(a => a.ready));
    const images = [];
    const lines = [];
    for (const a of list) {
      if (a.error || !a.images.length) continue;
      if (a.kind === 'image') {
        lines.push(`Attached image: ${a.path || a.name}`);
      } else {
        lines.push(`Attached video: ${a.path || a.name} (${formatClock(a.duration || 0)} long). The ${a.images.length} pictures for it are frames at ${a.times.map(formatClock).join(', ')}.`);
      }
      images.push(...a.images.map(({ mediaType, data }) => ({ mediaType, data })));
    }
    return { images, note: lines.join('\n') };
  }

  render() {
    const list = this.current();
    this.row.textContent = '';
    this.row.classList.toggle('hidden', !list.length);
    for (const a of list) {
      const chip = el('div', `attach-chip ${a.kind}` + (a.error ? ' error' : '') + (!a.thumb && !a.error ? ' loading' : ''));
      chip.title = a.error ? `${a.name}: ${a.error}` : a.path || a.name;
      if (a.thumb) {
        const img = document.createElement('img');
        img.src = a.thumb;
        img.alt = a.name;
        chip.appendChild(img);
      }
      if (a.kind === 'video') chip.appendChild(el('span', 'attach-badge', a.duration ? `▶ ${formatClock(a.duration)}` : '▶'));
      if (a.error) chip.appendChild(el('span', 'attach-badge', '!'));
      const remove = el('button', 'attach-remove', '✕');
      remove.type = 'button';
      remove.title = 'Remove';
      remove.onclick = () => this.remove(a.id);
      chip.appendChild(remove);
      this.row.appendChild(chip);
    }
    this.onChange?.();
  }
}

window.Attachments = Attachments;
