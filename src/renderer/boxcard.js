// Turns the text boxes some skills make agents write, like
//
//   ╔══════════════════════╗
//   ║  CHANGES             ║
//   ╠══════════════════════╣
//   ║  • File.controller   ║
//   ║    what changed      ║
//   ╠══════════════════════╣
//   ║  BEFORE              ║
//   ║  A ──► B ──► C       ║
//   ║  note  note ✗        ║
//   ╚══════════════════════╝
//
// into a card: the first line in capitals is the title, ╠═╣ lines separate
// sections, lines in capitals are labels, "•" lines are a list, lines with
// arrows are a chain of steps, and the line under a chain holds a note per
// step, found by column. ✓ and ✗ color a step green or red.
//
// extractBoxes() takes the boxes out of the Markdown before it is rendered and
// leaves a placeholder; renderBoxCard() builds the card for a placeholder.

const ARROW = /\s*(?:─+►|─+>|-+>|→|⟶|=>)\s*/g;
const GOOD = /[✓✔]/;
const BAD = /[✗✘]/;

function isCaps(line) {
  const t = line.trim();
  return t.length > 1 && t.length < 40 && /[A-Z]/.test(t) && t === t.toUpperCase() && /^[A-Z0-9 &/()'.:-]+$/.test(t);
}

function isBullet(line) {
  return /^\s*[•·\-*▸►]\s+/.test(line);
}

// Finds boxes (with an optional ``` fence around them) and replaces each with
// a placeholder element. Returns the new text and the boxes' lines.
//
// A box inside a code block with more text in it (a box, then a diagram, in
// one ``` block) splits the block: it is closed before the box and opened
// again after it, so the rest stays a code block and the text after the
// block stays text.
function extractBoxes(text) {
  if (!text.includes('╔')) return { text, boxes: [] };
  const lines = text.split('\n');
  const out = [];
  const boxes = [];
  let fence = null;   // the line that opened the code block we are in
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = fence ? null : line;
      out.push(line);
      continue;
    }
    if (!line.trim().startsWith('╔')) {
      out.push(line);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].trim().startsWith('╚')) end++;
    if (end >= lines.length) {
      out.push(line);
      continue;
    }
    // Close the code block around the box: drop its opening when the box is
    // the first thing in it.
    if (fence) {
      let k = out.length - 1;
      while (k >= 0 && !out[k].trim() && out[k] !== fence) k--;
      if (k >= 0 && out[k] === fence) out.length = k;
      else out.push(fence.match(/^\s*(```|~~~)/)[1]);
    }
    boxes.push(lines.slice(i, end + 1));
    out.push('', `<div data-boxcard="${boxes.length - 1}"></div>`, '');
    i = end;
    // Open it again for the rest, unless it ends right after the box.
    if (fence) {
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && /^\s*(```|~~~)\s*$/.test(lines[k])) {
        fence = null;
        i = k;
      } else {
        out.push(fence);
      }
    }
  }
  return { text: out.join('\n'), boxes };
}

// The box's inner lines, split into sections at ╠═╣ lines.
function parseBox(boxLines) {
  const sections = [[]];
  for (const raw of boxLines.slice(1, -1)) {
    const line = raw.trim();
    if (/^[╠╟]/.test(line)) {
      sections.push([]);
      continue;
    }
    const first = line.indexOf('║');
    const last = line.lastIndexOf('║');
    if (first < 0) continue;
    sections[sections.length - 1].push(line.slice(first + 1, last > first ? last : undefined).replace(/\s+$/, ''));
  }
  // Remove the indentation all lines of the box share, so columns still line up.
  const all = sections.flat().filter(l => l.trim());
  const indent = Math.min(...all.map(l => l.match(/^ */)[0].length));
  return sections
    .map(s => s.map(l => l.slice(Number.isFinite(indent) ? indent : 0)))
    .map(s => {
      while (s.length && !s[0].trim()) s.shift();
      while (s.length && !s[s.length - 1].trim()) s.pop();
      return s;
    })
    .filter(s => s.length);
}

// Text with ✓ and ✗ colored.
function markedText(text, className) {
  const span = el('span', className);
  for (const part of text.split(/([✓✔✗✘])/)) {
    if (!part) continue;
    if (GOOD.test(part)) span.appendChild(el('span', 'box-good', part));
    else if (BAD.test(part)) span.appendChild(el('span', 'box-bad', part));
    else span.appendChild(document.createTextNode(part));
  }
  return span;
}

// A chain "A ──► B ──► C"; the next line holds a note per step, by column.
function renderFlow(line, noteLine) {
  const steps = [];
  let last = 0;
  let m;
  ARROW.lastIndex = 0;
  while ((m = ARROW.exec(line))) {
    steps.push({ text: line.slice(last, m.index), start: last });
    last = m.index + m[0].length;
  }
  steps.push({ text: line.slice(last), start: last });
  steps.forEach((s, i) => {
    const end = i + 1 < steps.length ? steps[i + 1].start : Infinity;
    // A note belongs to a step when it starts in that step's columns.
    s.note = noteLine ? noteLine.slice(i === 0 ? 0 : s.start - 2, end === Infinity ? undefined : end - 2).trim() : '';
  });

  const flow = el('div', 'box-flow');
  steps.forEach((s, i) => {
    if (i) flow.appendChild(el('span', 'box-arrow', '→'));
    const step = el('div', 'box-step');
    const text = (s.text + ' ' + s.note).trim();
    if (BAD.test(text)) step.classList.add('bad');
    else if (GOOD.test(text)) step.classList.add('good');
    step.appendChild(markedText(s.text.trim(), 'box-step-text'));
    if (s.note) step.appendChild(markedText(s.note, 'box-step-note'));
    flow.appendChild(step);
  });
  return flow;
}

// "+ File.cs (new)", "~ File.cs", "- File.cs (removed)": a list of changes.
const CHANGE_LINE = /^\s*([+~−-])\s+(\S.*)$/;
const CHANGE_KIND = { '+': 'add', '~': 'mod', '-': 'del', '−': 'del' };

function renderSection(lines) {
  const section = el('div', 'box-section');
  let list = null;
  let changes = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      list = null;
      changes = null;
      continue;
    }
    // A change list: lines more indented than a change are its notes.
    const change = CHANGE_LINE.exec(line);
    // Only with a + or ~ line in the section: "-" alone is a plain bullet list.
    if (change && (changes || lines.some(l => /^\s*[+~]\s+\S/.test(l)))) {
      if (!changes) {
        changes = el('ul', 'box-changes');
        section.appendChild(changes);
      }
      const item = el('li', `box-change ${CHANGE_KIND[change[1]]}`);
      item.appendChild(el('span', 'box-change-sign', change[1] === '-' ? '−' : change[1]));
      const body = el('div', 'box-change-body');
      const rest = change[2];
      const tag = /\s*\(([^)]*)\)\s*$/.exec(rest);
      const head = tag ? rest.slice(0, tag.index) : rest;
      const top = el('div');
      top.appendChild(markedText(head, /^[\w./@\\-]+\.\w+$/.test(head.trim()) ? 'box-file' : 'box-item'));
      if (tag) top.appendChild(el('span', 'box-change-tag', tag[1]));
      body.appendChild(top);
      const indent = line.match(/^\s*/)[0].length;
      while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].match(/^\s*/)[0].length > indent) {
        body.appendChild(markedText(lines[++i].trim(), 'box-item-note'));
      }
      item.appendChild(body);
      changes.appendChild(item);
      continue;
    }
    changes = null;
    if (isBullet(line)) {
      if (!list) {
        list = el('ul', 'box-list');
        section.appendChild(list);
      }
      const item = el('li');
      const head = line.replace(/^\s*[•·\-*▸►]\s+/, '');
      // A file name reads better in the code font.
      item.appendChild(markedText(head, /^[\w./@-]+\.\w+$/.test(head.trim()) ? 'box-file' : 'box-item'));
      const indent = line.match(/^\s*/)[0].length;
      while (i + 1 < lines.length && lines[i + 1].trim() && !isBullet(lines[i + 1]) && lines[i + 1].match(/^\s*/)[0].length > indent) {
        item.appendChild(markedText(lines[++i].trim(), 'box-item-note'));
      }
      list.appendChild(item);
      continue;
    }
    list = null;
    if (isCaps(line)) {
      const label = line.trim();
      section.appendChild(el('div', 'box-label' + (/^BEFORE|^OLD|^PROBLEM/.test(label) ? ' before' : /^AFTER|^NEW|^FIX/.test(label) ? ' after' : ''), label));
      continue;
    }
    ARROW.lastIndex = 0;
    if (ARROW.test(line)) {
      const next = lines[i + 1];
      ARROW.lastIndex = 0;
      const noteLine = next && next.trim() && !isBullet(next) && !isCaps(next) && !ARROW.test(next) ? lines[++i] : null;
      section.appendChild(renderFlow(line, noteLine));
      continue;
    }
    section.appendChild(markedText(line.trim(), 'box-text'));
  }
  return section;
}

// The card for one box. "Text" switches to the box as the agent wrote it.
function renderBoxCard(boxLines) {
  const sections = parseBox(boxLines);
  const card = el('div', 'box-card');
  const head = el('div', 'box-head');
  let rest = sections;
  if (sections[0]?.length === 1 && isCaps(sections[0][0])) {
    head.appendChild(el('span', 'box-title', sections[0][0].trim()));
    rest = sections.slice(1);
  }
  const toggle = el('button', 'box-toggle', 'Text');
  toggle.title = 'Show the box as the agent wrote it';
  head.appendChild(toggle);
  card.appendChild(head);

  const body = el('div', 'box-body');
  for (const s of rest) body.appendChild(renderSection(s));
  const raw = el('pre', 'box-raw hidden', boxLines.join('\n'));
  toggle.onclick = () => {
    const showRaw = raw.classList.contains('hidden');
    raw.classList.toggle('hidden', !showRaw);
    body.classList.toggle('hidden', showRaw);
    toggle.textContent = showRaw ? 'Card' : 'Text';
  };
  card.append(body, raw);
  return card;
}

// ---------- text diagrams ----------

// Diagrams drawn with line characters, like
//
//   [Console] Command
//         │
//         ▼
//   Repository ── every id
//         ├─ for each id ──┬─ Unload()   → closed
//         │                └─ Delete()   → deleted
//
// only line up in a font where every character is as wide as the next. They
// get a diagram block: that font, lines dimmed and arrows in the accent
// color, and a size that fits the chat's width instead of a scroll bar.
const GRAPH_LINE = /[│┃├┤┬┴┼└┘┌┐╭╮╯╰▼▲►◄▶◀↓↑]|──/;
const GRAPH_TOKEN = /([│┃├┤┬┴┼└┘┌┐╭╮╯╰─━═]+)|([▼▲►◄▶◀↓↑→←⟶]+|-->|->|=>)|("[^"]*"|'[^']*')|(\[[^\]\n]{1,60}\])|([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*\([^()\n]*\))/g;

function looksLikeGraph(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const graph = lines.filter(l => GRAPH_LINE.test(l)).length;
  return lines.length >= 2 && graph >= 2 && graph / lines.length >= 0.3;
}

// Diagram lines written as plain text (no ``` around them) get a fence, so
// they reach renderTextGraph like fenced ones.
function fenceGraphs(text) {
  if (!GRAPH_LINE.test(text)) return text;
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence || !lines[i].trim() || !GRAPH_LINE.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // The run of text lines around it (back to the last blank line).
    let start = out.length;
    while (start > 0 && out[start - 1].trim() && !/^\s*(```|~~~|#|[-*] |\d+\. )/.test(out[start - 1])) start--;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trim() && !/^\s*(```|~~~)/.test(lines[end + 1])) end++;
    const run = [...out.slice(start), ...lines.slice(i, end + 1)];
    if (looksLikeGraph(run.join('\n'))) {
      out.length = start;
      out.push('```graph', ...run, '```');
    } else {
      out.push(...lines.slice(i, end + 1));
    }
    i = end;
  }
  return out.join('\n');
}

function renderTextGraph(text) {
  let lines = text.replace(/\s+$/, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
  if (Number.isFinite(indent)) lines = lines.map(l => l.slice(indent));
  const box = el('div', 'text-graph');
  const pre = el('pre');
  for (const line of lines) {
    let last = 0;
    for (const m of line.matchAll(GRAPH_TOKEN)) {
      if (m.index > last) pre.append(line.slice(last, m.index));
      const cls = m[1] ? 'tg-line' : m[2] ? 'tg-arrow' : m[3] ? 'tg-str' : m[4] ? 'tg-tag' : 'tg-code';
      pre.append(el('span', cls, m[0]));
      last = m.index + m[0].length;
    }
    pre.append(line.slice(last) + '\n');
  }
  box.appendChild(pre);
  // Smaller text instead of a scroll bar, down to a size that stays readable.
  const fit = () => {
    pre.style.fontSize = '';
    const width = box.clientWidth - 24;
    if (width > 0 && pre.scrollWidth > width) {
      const base = parseFloat(getComputedStyle(pre).fontSize) || 13;
      pre.style.fontSize = `${Math.max(9, Math.floor(base * width / pre.scrollWidth * 10) / 10)}px`;
    }
  };
  new ResizeObserver(fit).observe(box);
  const toggle = el('button', 'box-toggle', 'Copy');
  toggle.title = 'Copy the diagram as text';
  toggle.onclick = () => {
    navigator.clipboard?.writeText(lines.join('\n'));
    toggle.textContent = 'Copied';
    setTimeout(() => { toggle.textContent = 'Copy'; }, 1200);
  };
  box.appendChild(toggle);
  return box;
}

// After the Markdown is rendered: code blocks that are diagrams (```graph, or
// no language and mostly line characters) become diagram blocks.
function decorateGraphs(root) {
  for (const code of root.querySelectorAll('pre > code')) {
    const lang = [...code.classList].find(c => c.startsWith('language-'))?.slice(9) || '';
    if (lang && !['graph', 'text', 'txt', 'plaintext'].includes(lang)) continue;
    const text = code.textContent;
    if (lang !== 'graph' && !looksLikeGraph(text)) continue;
    code.parentElement.replaceWith(renderTextGraph(text));
  }
  return root;
}

window.extractBoxes = extractBoxes;
window.fenceGraphs = fenceGraphs;
window.decorateGraphs = decorateGraphs;
window.renderBoxCard = renderBoxCard;
