// A picture of a Photoshop file (.psd, and .psb, Photoshop's "large
// document" format that Unity's 2D rigs use), for the chat and for files you
// attach to a message. Neither Chromium nor Claude reads these, so the app
// makes a PNG of the flattened image Photoshop saves at the end of the file
// (with "Maximize compatibility", the default), sized down to maxSide.
// Without one it falls back to the small JPEG preview Photoshop keeps in the
// file's image resources (resource 1036).
//
// The file: a header ("8BPS", version 1 for psd and 2 for psb, channels,
// height, width, bit depth, color mode), then three sections that each start
// with their length (color mode data, image resources, layers), then the
// flattened image: a compression code and each channel's rows one after
// another, raw or run-length encoded (PackBits, with every row's byte count
// up front). psb uses 8 bytes for the layers' length and 4 for each row's
// byte count, where psd uses 4 and 2.

const fs = require('fs');
const zlib = require('zlib');

const MAX_FILE = 2 * 1024 * 1024 * 1024;

function readAt(fd, pos, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, pos);
  return n === length ? buf : buf.subarray(0, n);
}

// One row of a channel, unpacked (PackBits) into out.
function unpackRow(src, out) {
  let i = 0;
  let o = 0;
  while (i < src.length && o < out.length) {
    const n = src[i++];
    if (n < 128) {
      const count = n + 1;
      src.copy(out, o, i, i + count);
      i += count;
      o += count;
    } else if (n > 128) {
      const count = 257 - n;
      out.fill(src[i++], o, o + count);
      o += count;
    }
  }
}

// The flattened image as RGBA pixels, maxSide at most (every source row and
// column it needs is picked, nearest first: a few rows of a big file are
// read, not the whole file). Resolves to { width, height, rgba } or null.
function composite(fd, size, header, pos, maxSide) {
  const { channels, height, width, depth, mode, big } = header;
  if (![1, 3].includes(mode) || ![8, 16].includes(depth)) return null;   // grayscale or RGB
  const compression = readAt(fd, pos, 2).readUInt16BE(0);
  pos += 2;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const rowsWanted = Array.from({ length: h }, (_, y) => Math.min(height - 1, Math.floor((y + 0.5) / scale)));
  const cols = Array.from({ length: w }, (_, x) => Math.min(width - 1, Math.floor((x + 0.5) / scale)));
  const bytesPerSample = depth / 8;
  const rowBytes = width * bytesPerSample;
  const used = mode === 3 ? Math.min(channels, 4) : Math.min(channels, 2);
  const rgba = Buffer.alloc(w * h * 4, 255);
  // Where each channel's rows start, and how long each is.
  let rowStart;   // (channel, row) -> [offset, length]
  if (compression === 0) {
    rowStart = (c, y) => [pos + (c * height + y) * rowBytes, rowBytes];
  } else if (compression === 1) {
    const countSize = big ? 4 : 2;
    const counts = readAt(fd, pos, channels * height * countSize);
    if (counts.length < channels * height * countSize) return null;
    const offsets = new Float64Array(channels * height + 1);
    offsets[0] = pos + counts.length;
    for (let i = 0; i < channels * height; i++) {
      offsets[i + 1] = offsets[i] + (big ? counts.readUInt32BE(i * 4) : counts.readUInt16BE(i * 2));
    }
    if (offsets[channels * height] > size + 16) return null;
    rowStart = (c, y) => [offsets[c * height + y], offsets[c * height + y + 1] - offsets[c * height + y]];
  } else {
    return null;   // zip-compressed (rare in Photoshop's own files)
  }
  const row = Buffer.alloc(rowBytes);
  for (let c = 0; c < used; c++) {
    // RGB(A): channel c is R, G, B, A; grayscale: gray (to all three), alpha.
    const targets = mode === 3 ? [c] : c === 0 ? [0, 1, 2] : [3];
    for (let y = 0; y < h; y++) {
      const [at, length] = rowStart(c, rowsWanted[y]);
      const src = readAt(fd, at, length);
      if (compression === 1) unpackRow(src, row);
      else src.copy(row);
      const base = y * w * 4;
      for (let x = 0; x < w; x++) {
        const v = row[cols[x] * bytesPerSample];   // 16-bit: its high byte
        for (const t of targets) rgba[base + x * 4 + t] = v;
      }
    }
  }
  // Photoshop saves the colors of see-through pixels blended with white:
  // take the white back out.
  if (used === 4 || (mode === 1 && used === 2)) {
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a === 255) continue;
      if (a === 0) { rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; continue; }
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.max(0, Math.min(255, Math.round((rgba[i + k] - (255 - a)) * 255 / a)));
    }
  }
  // Without "Maximize compatibility" Photoshop saves a blank white image.
  let blank = true;
  for (let i = 0; i < rgba.length && blank; i += 4) blank = rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255;
  return blank ? null : { width: w, height: h, rgba };
}

// The JPEG preview in the image resources, or null.
function thumbnail(resources) {
  let p = 0;
  while (p + 12 <= resources.length && resources.toString('latin1', p, p + 4) === '8BIM') {
    const id = resources.readUInt16BE(p + 4);
    const name = resources[p + 6];
    let q = p + 6 + ((name + 2) & ~1);
    const size = resources.readUInt32BE(q);
    q += 4;
    if (id === 1036 && size > 28) return resources.subarray(q + 28, q + size);
    p = q + size + (size & 1);
  }
  return null;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function png({ width, height, rgba }) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Resolves to { data: Buffer, type: 'image/png' | 'image/jpeg', width,
// height } (the size of the document), or null when the file has no picture
// the app can read.
function preview(file, maxSide = 2048) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size > MAX_FILE) return null;
    const head = readAt(fd, 0, 26);
    if (head.length < 26 || head.toString('latin1', 0, 4) !== '8BPS') return null;
    const version = head.readUInt16BE(4);
    const header = {
      big: version === 2,
      channels: head.readUInt16BE(12),
      height: head.readUInt32BE(14),
      width: head.readUInt32BE(18),
      depth: head.readUInt16BE(22),
      mode: head.readUInt16BE(24),
    };
    let pos = 26;
    pos += 4 + readAt(fd, pos, 4).readUInt32BE(0);                  // color mode data
    const resourcesLength = readAt(fd, pos, 4).readUInt32BE(0);
    const resources = readAt(fd, pos + 4, Math.min(resourcesLength, 32 * 1024 * 1024));
    pos += 4 + resourcesLength;
    const layers = readAt(fd, pos, header.big ? 8 : 4);
    pos += header.big ? 8 + Number(layers.readBigUInt64BE(0)) : 4 + layers.readUInt32BE(0);
    const image = pos < size ? composite(fd, size, header, pos, maxSide) : null;
    if (image) return { data: png(image), type: 'image/png', width: header.width, height: header.height };
    const jpeg = thumbnail(resources);
    return jpeg ? { data: Buffer.from(jpeg), type: 'image/jpeg', width: header.width, height: header.height } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

module.exports = { preview };
