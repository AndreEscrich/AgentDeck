// An Excel file (.xlsx, .xlsm) you attach to a message: the app reads its
// sheets as CSV text, so the agent gets the data with your message (an agent
// cannot read the file itself without a Python package).
//
// An .xlsx file is a zip of XML files. The zip's table of contents (the
// central directory) is at the end of the file; each file in it is stored as
// it is or packed with deflate, which zlib unpacks. The parts read:
//   xl/workbook.xml             the sheets' names, in order
//   xl/_rels/workbook.xml.rels  which XML file holds each sheet
//   xl/sharedStrings.xml        the texts, which cells name by number
//   xl/styles.xml               which cells hold dates (their number format)
//   xl/worksheets/sheetN.xml    the cells
// A cell shows its value as Excel last saved it (a formula's result, not the
// formula). Dates become 2026-11-05 (and 14:30 with a time).
//
// read(file, limit) resolves with { ok, sheets: [{ name, rows, cols, shown,
// csv, hidden }] } or { ok: false, error }. The CSV text of all sheets
// together stays under limit characters: a sheet that does not fit shows its
// first rows (shown of rows).

const fs = require('fs');
const zlib = require('zlib');

const MAX_FILE = 60 * 1024 * 1024;

function unzip(buf) {
  // The end of central directory record: its signature, searched from the end
  // (a zip comment can follow it).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not an .xlsx file (an old .xls file? Save it as .xlsx in Excel).');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return name => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return data.toString('utf8');
    if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new Error(`${name} is packed in a way the app cannot read.`);
  };
}

const unxml = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// The attributes of one tag: { name: value }, without namespace prefixes
// (r:id is id).
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1].replace(/^\w+:/, '')] = unxml(m[2]);
  return out;
}

// The text in a string item (<si> or <is>): its <t> parts, without the
// phonetic guides (<rPh>) Japanese files have.
const textOf = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unxml(m[1])).join('');

// Which styles (the s="…" of a cell) are dates or times.
function dateStyles(xml) {
  if (!xml) return new Set();
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrs(m[0]);
    custom.set(Number(a.numFmtId), a.formatCode || '');
  }
  // A format is a date when it has d, m, y, h or s outside quotes and [colours].
  const isDateFormat = code => /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  const builtIn = id => (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || '';
  const dates = new Set();
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
    const id = Number(attrs(m[0]).numFmtId || 0);
    if (builtIn(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dates.add(i);
  });
  return dates;
}

// A date's serial number (days since 1900, or since 1904 in old Mac files)
// as 2026-11-05, with the time when it has one.
function dateText(serial, date1904) {
  const ms = Math.round((serial - (date1904 ? -1462 : 25569)) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  const time = iso.slice(11, 16);
  if (serial < 1) return time;   // a time without a day
  return time === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}

// "AB12" -> 27 (the column, from 0).
function column(ref) {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] || '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

const csvCell = v => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function readSheet(xml, strings, dates, date1904) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const index = Number(attrs(r[1]).r || rows.length + 1) - 1;
    const row = [];
    let next = 0;
    for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1]);
      const col = a.r ? column(a.r) : next;
      next = col + 1;
      const body = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (a.t === 's') value = strings[Number(v)] ?? '';
      else if (a.t === 'inlineStr') value = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] || '');
      else if (a.t === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else if (v != null) {
        value = unxml(v);
        if (a.t !== 'str' && a.t !== 'e' && dates.has(Number(a.s)) && value !== '' && !Number.isNaN(Number(value))) value = dateText(Number(value), date1904);
      }
      if (value !== '') row[col] = value;
    }
    if (row.length) rows[index] = row;
  }
  // Rows and columns up to the last one with something in it.
  const filled = Array.from(rows, r => r || []);
  const cols = filled.reduce((n, r) => Math.max(n, r.length), 0);
  return { lines: filled.map(r => Array.from({ length: r.length }, (_, i) => csvCell(r[i] ?? '')).join(',')), cols };
}

async function read(file, limit = 60000) {
  try {
    if (typeof file !== 'string' || !/\.(xlsx|xlsm)$/i.test(file)) return { ok: false, error: 'Not an .xlsx file.' };
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_FILE) return { ok: false, error: `Too large to read here (${Math.round(stat.size / 1048576)} MB). It goes by its path.` };
    const get = unzip(await fs.promises.readFile(file));
    const workbook = get('xl/workbook.xml');
    if (!workbook) return { ok: false, error: 'This file has no workbook in it.' };
    const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
    const rels = new Map();
    for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
      const a = attrs(m[0]);
      rels.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`);
    }
    const strings = [...(get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => textOf(m[1] || ''));
    const dates = dateStyles(get('xl/styles.xml'));
    const sheets = [];
    let left = limit;
    for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const xml = get(rels.get(a.id) || '');
      if (xml == null) continue;   // a chart sheet, or a part that is missing
      const { lines, cols } = readSheet(xml, strings, dates, date1904);
      let shown = 0;
      let size = 0;
      for (const line of lines) {
        if (size + line.length + 1 > left) break;
        size += line.length + 1;
        shown++;
      }
      left -= size;
      sheets.push({ name: a.name || `Sheet ${sheets.length + 1}`, hidden: !!a.state && a.state !== 'visible', rows: lines.length, cols, shown, csv: lines.slice(0, shown).join('\n') });
    }
    if (!sheets.length) return { ok: false, error: 'No sheet with cells in it.' };
    return { ok: true, sheets };
  } catch (err) {
    return { ok: false, error: err?.code === 'ENOENT' ? 'The file is not there any more.' : err?.message || String(err) };
  }
}

module.exports = { read };
