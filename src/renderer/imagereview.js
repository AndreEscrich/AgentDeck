// Reviewing an image from an agent's reply, the way line comments review
// code (diffview.js): click the image to open it in review mode, draw on it
// (a circle round a part, an arrow, a scribble) and, when you let go, type
// what should change there. Each mark gets a number. "Send N notes" puts the
// notes into the message box, as one message to the agent, with the image
// attached as you marked it (the marks drawn on it, numbered), so the agent
// sees where each note is. Notes stay with the image until they are sent,
// also when you close it and open it again.
//
// The window cannot read the pixels of an image media:// shows it (another
// origin), so the marked copy is drawn from the bytes the main process hands
// over (pictureData in media.js).

const imageReviews = new Map();   // image path -> [{ points: [[x, y], …] in image pixels, text }]
const SVG_NS_REVIEW = 'http://www.w3.org/2000/svg';
const MARK_COLOR = '#ff3d7f';

function reviewSvg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS_REVIEW, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// A mark's box in image pixels.
function markBounds(points) {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

// "top left", "middle", "bottom right": where a box is in the image.
function whereInImage(b, w, h) {
  const cx = (b.x1 + b.x2) / 2 / w;
  const cy = (b.y1 + b.y2) / 2 / h;
  const row = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'middle' : 'bottom';
  const col = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'centre' : 'right';
  return row === 'middle' && col === 'centre' ? 'middle' : row === 'middle' ? `${col}` : `${row} ${col === 'centre' ? '' : col}`.trim();
}

function pathData(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}

function openImageReview(file) {
  const marks = imageReviews.get(file) || [];
  imageReviews.set(file, marks);
  const name = file.split(/[\\/]/).pop();

  const box = el('div', 'image-review');
  const head = el('div', 'image-review-head');
  const title = el('div', 'image-review-title');
  title.append(el('span', 'image-review-name', name), el('span', 'image-review-hint', 'Draw on the image, then write what should change there'));
  const clearBtn = el('button', null, 'Clear');
  clearBtn.type = 'button';
  clearBtn.title = 'Remove every note';
  const sendBtn = el('button', 'primary image-review-send');
  sendBtn.type = 'button';
  sendBtn.title = 'Put the notes into the message box, with the image as you marked it attached';
  const closeBtn = el('button', null, 'Close (Esc)');
  closeBtn.type = 'button';
  closeBtn.title = 'Close: the notes stay with the image until you send them';
  head.append(title, clearBtn, sendBtn, closeBtn);

  const main = el('div', 'image-review-main');
  const stage = el('div', 'image-review-stage');
  const img = document.createElement('img');
  img.src = mediaUrl(file);
  img.alt = name;
  img.draggable = false;
  const svg = reviewSvg('svg', { class: 'image-review-marks', preserveAspectRatio: 'none' });
  stage.append(img, svg);
  const list = el('div', 'image-review-notes');
  main.append(stage, list);
  box.append(head, main, el('div', 'lightbox-path', file));

  let w = 0;
  let h = 0;
  let editor = null;
  // Image pixels per pixel on screen: marks keep the same thickness on screen.
  const scale = () => (w && img.clientWidth ? w / img.clientWidth : 1);
  const toImage = e => {
    const r = img.getBoundingClientRect();
    return [Math.max(0, Math.min(w, (e.clientX - r.left) * w / r.width)), Math.max(0, Math.min(h, (e.clientY - r.top) * h / r.height))];
  };

  const refresh = () => {
    sendBtn.textContent = `Send ${marks.length} note${marks.length === 1 ? '' : 's'}`;
    sendBtn.disabled = !marks.length;
    clearBtn.disabled = !marks.length;
    draw();
    list.textContent = '';
    list.classList.toggle('hidden', !marks.length);
    marks.forEach((m, i) => {
      const item = el('button', 'image-review-note');
      item.type = 'button';
      item.title = 'Edit this note';
      item.append(el('span', 'image-review-num', String(i + 1)), el('span', 'image-review-note-text', m.text));
      item.onclick = () => editNote(m, null);
      list.appendChild(item);
    });
  };

  // The marks, each with its number where it starts.
  const draw = (pending = null) => {
    svg.textContent = '';
    if (!w) return;
    const s = scale();
    const stroke = 3 * s;
    const all = pending ? [...marks, { points: pending, pending: true }] : marks;
    all.forEach((m, i) => {
      const g = reviewSvg('g', { class: 'image-review-mark' + (m.pending ? ' pending' : '') });
      const d = m.points.length > 1 ? pathData(m.points) : `M${m.points[0][0]},${m.points[0][1]} l0.01,0`;
      g.append(
        reviewSvg('path', { d, fill: 'none', stroke: 'rgba(0,0,0,0.55)', 'stroke-width': stroke + 3 * s, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        reviewSvg('path', { d, fill: 'none', stroke: MARK_COLOR, 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
      if (!m.pending) {
        // At the start of the stroke, just above and left of it.
        const r = 11 * s;
        const cx = Math.max(r, Math.min(w - r, m.points[0][0] - r * 0.8));
        const cy = Math.max(r, Math.min(h - r, m.points[0][1] - r * 0.8));
        const badge = reviewSvg('g', { class: 'image-review-badge' });
        badge.append(
          reviewSvg('circle', { cx, cy, r, fill: MARK_COLOR, stroke: '#fff', 'stroke-width': 1.5 * s }),
          Object.assign(reviewSvg('text', { x: cx, y: cy, 'font-size': 13 * s, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#fff' }), { textContent: String(i + 1) }),
        );
        badge.addEventListener('pointerdown', e => { e.stopPropagation(); editNote(m, null); });
        g.appendChild(badge);
      }
      svg.appendChild(g);
    });
  };

  // The note's box, where you let go of a new mark (at), or under the list
  // for a note you edit. ↩ saves, ⇧↩ is a new line, Esc cancels (a new
  // mark goes with it).
  const editNote = (mark, at) => {
    closeEditor(false);
    const isNew = !marks.includes(mark);
    const ed = el('div', 'image-review-editor');
    const input = document.createElement('textarea');
    input.rows = 3;
    input.placeholder = 'What should change here? (↩ to save, ⇧↩ for a new line, Esc to cancel)';
    input.value = mark.text || '';
    const buttons = el('div', 'review-comment-actions');
    const cancel = el('button', null, 'Cancel');
    const save = el('button', 'review-comment-save', isNew ? 'Add note' : 'Save');
    if (!isNew) {
      const del = el('button', null, 'Delete');
      del.onclick = () => { marks.splice(marks.indexOf(mark), 1); closeEditor(false); window.uiSound?.('detach'); refresh(); };
      buttons.appendChild(del);
    }
    buttons.append(cancel, save);
    ed.append(input, buttons);
    editor = { el: ed, mark, isNew, input };
    cancel.onclick = () => closeEditor(false);
    save.onclick = () => closeEditor(true);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); closeEditor(true); }
    });
    ed.addEventListener('pointerdown', e => e.stopPropagation());
    box.appendChild(ed);
    // Beside where you let go, kept inside the window.
    const rect = ed.getBoundingClientRect();
    const x = at ? at.x + 14 : window.innerWidth - rect.width - 24;
    const y = at ? at.y + 14 : 80;
    ed.style.left = `${Math.max(12, Math.min(window.innerWidth - rect.width - 12, x))}px`;
    ed.style.top = `${Math.max(12, Math.min(window.innerHeight - rect.height - 12, y))}px`;
    input.focus();
    if (isNew) draw(mark.points);
  };
  const closeEditor = keep => {
    if (!editor) return;
    const { el: ed, mark, isNew, input } = editor;
    editor = null;
    ed.remove();
    const text = input.value.trim();
    if (keep && text) {
      mark.text = text;
      if (isNew) { marks.push(mark); window.uiSound?.('pick'); }
    } else if (keep && !isNew) {
      marks.splice(marks.indexOf(mark), 1);
    }
    refresh();
  };

  // Drawing: press, move, let go; then the note's box opens.
  let drawing = null;
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !w) return;
    e.preventDefault();
    e.stopPropagation();
    if (editor) { closeEditor(!!editor.input.value.trim()); return; }
    svg.setPointerCapture(e.pointerId);
    drawing = [toImage(e)];
    draw(drawing);
  });
  svg.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = toImage(e);
    const last = drawing[drawing.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2 * scale()) return;
    drawing.push(p);
    draw(drawing);
  });
  const finish = e => {
    if (!drawing) return;
    const points = drawing;
    drawing = null;
    editNote({ points, text: '' }, { x: e.clientX, y: e.clientY });
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', () => { drawing = null; draw(); });
  // Pressing and moving would otherwise start the browser's own drag (of the
  // image or of selected text), which takes the mouse from the drawing.
  svg.addEventListener('mousedown', e => e.preventDefault());
  box.addEventListener('dragstart', e => e.preventDefault());

  // As large as the window allows beside the notes, also a small sprite
  // (enlarged with its pixels kept sharp), so there is room to draw.
  const fit = () => {
    if (!w) return;
    const k = Math.min((window.innerWidth - 36 - 316) / w, (window.innerHeight - 130) / h);
    img.style.width = `${Math.max(1, Math.round(w * k))}px`;
    img.style.height = `${Math.max(1, Math.round(h * k))}px`;
    img.classList.toggle('pixelated', k >= 2);
  };
  img.addEventListener('load', () => {
    w = img.naturalWidth;
    h = img.naturalHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    fit();
    refresh();
  });
  const onResize = () => { fit(); draw(); };
  window.addEventListener('resize', onResize);

  const close = () => {
    closeEditor(!!editor?.input.value.trim());
    window.uiSound?.('tickDown');
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
  };
  const onKey = e => {
    // Esc cancels the note you are writing first, then closes.
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (editor) closeEditor(false); else close(); }
    // Ctrl+Z (⌘Z) takes back the last note.
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && marks.length && !editor) { e.preventDefault(); marks.pop(); refresh(); }
  };
  document.addEventListener('keydown', onKey, true);
  // A click beside the image and the notes closes it.
  box.addEventListener('pointerdown', e => { if (e.target === box || e.target === main) close(); });
  closeBtn.onclick = close;
  clearBtn.onclick = () => { marks.length = 0; closeEditor(false); refresh(); };
  sendBtn.onclick = async () => {
    if (!marks.length) return;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Preparing…';
    try {
      await sendImageReview(file, marks.slice(), w, h);
      marks.length = 0;
      close();
    } catch (err) {
      sendBtn.disabled = false;
      refresh();
      window.toast?.(`Could not prepare the image: ${err?.message || err}`);
    }
  };

  document.body.appendChild(box);
  window.uiSound?.('tick');
  refresh();
}

// The image with the marks drawn on it as a PNG file, and the message: each note with its number and where
// it is. The app attaches the file and puts the message in the message box
// (see 'image-review' in app.js).
async function sendImageReview(file, marks, w, h) {
  const pic = await window.deck.pictureData(file);
  if (!pic) throw new Error('the app could not read it');
  // Decoded straight from the bytes (an <img> can wait for the window to paint).
  const bytes = Uint8Array.from(atob(pic.data), ch => ch.charCodeAt(0));
  const img = await createImageBitmap(new Blob([bytes], { type: pic.mediaType }));
  // At most 2048 pixels on its long side, and a small sprite enlarged to at
  // least 768 (pixels kept sharp), so the marks do not hide it.
  const long = Math.max(img.width, img.height);
  const s = Math.min(2048 / long, Math.max(1, 768 / long));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * s);
  canvas.height = Math.round(img.height * s);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = s < 2;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // Marks were drawn on the picture as shown (w × h): the same places here.
  const k = canvas.width / (w || img.width);
  const line = Math.max(3, Math.max(canvas.width, canvas.height) / 300);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  marks.forEach((m, i) => {
    const pts = m.points.map(([x, y]) => [x * k, y * k]);
    for (const [color, width] of [['rgba(0,0,0,0.55)', line + 3], [MARK_COLOR, line]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
      ctx.stroke();
    }
    const r = Math.max(12, line * 3.6);
    const cx = Math.max(r, Math.min(canvas.width - r, pts[0][0] - r * 0.8));
    const cy = Math.max(r, Math.min(canvas.height - r, pts[0][1] - r * 0.8));
    ctx.fillStyle = MARK_COLOR;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, r / 7);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.15)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), cx, cy + 1);
  });
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the marked copy could not be made');
  const name = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const marked = new File([blob], `${name} (review).png`, { type: 'image/png' });

  const iw = w || img.width;
  const ih = h || img.height;
  const lines = [
    `Art review of ${file} (${iw}×${ih}):`,
    '',
    `The attached picture is that image with my marks drawn on it in pink; each mark has the number of its note. Places are in the image's own pixels.`,
    '',
  ];
  marks.forEach((m, i) => {
    const b = markBounds(m.points);
    const box = `x ${Math.round(b.x1)}–${Math.round(b.x2)}, y ${Math.round(b.y1)}–${Math.round(b.y2)}`;
    lines.push(`${i + 1}. ${whereInImage(b, iw, ih)} (${box}):`);
    lines.push(...m.text.split('\n').map(t => `   ${t}`), '');
  });
  lines.push('Please address each note.');
  window.dispatchEvent(new CustomEvent('image-review', { detail: { text: lines.join('\n'), file: marked } }));
}
