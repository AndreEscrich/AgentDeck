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
function extractBoxes(text) {
  if (!text.includes('╔')) return { text, boxes: [] };
  const lines = text.split('\n');
  const out = [];
  const boxes = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('╔')) {
      out.push(lines[i]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].trim().startsWith('╚')) end++;
    if (end >= lines.length) {
      out.push(lines[i]);
      continue;
    }
    // A code fence right around the box belongs to it.
    const before = out.length - 1;
    if (before >= 0 && /^\s*```/.test(out[before])) out.pop();
    let after = end + 1;
    if (after < lines.length && /^\s*```\s*$/.test(lines[after])) after++;
    boxes.push(lines.slice(i, end + 1));
    out.push('', `<div data-boxcard="${boxes.length - 1}"></div>`, '');
    i = after - 1;
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

function renderSection(lines) {
  const section = el('div', 'box-section');
  let list = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      list = null;
      continue;
    }
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

window.extractBoxes = extractBoxes;
window.renderBoxCard = renderBoxCard;
