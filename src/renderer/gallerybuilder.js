// The Gallery's builder (the right side of the Gallery, renderer/gallery.js).
//
// A canvas of CANVAS_W × CANVAS_H (a phone screen, portrait), shown as big
// as the view's height allows. Pieces are library images: drag one from the
// gallery on the left to add it, drag it to move, drag a corner to resize
// (keeping its shape), Delete removes it, [ and ] move it down and up the
// layers, arrows nudge it. The collage stays as you left it (this
// computer's storage).
//
// Create draws the collage at full size (CANVAS_BG where nothing is), sends it
// with the prompt to Create Art (main.js gallery:create → createart.js
// editImage), and puts what comes back on the canvas; it is saved into the
// gallery's Created category. Undo goes back, also to the collage before
// Create.

const CANVAS_W = 1080;
const CANVAS_H = 2340;
// What empty parts of the canvas are when the collage goes to Create Art.
const CANVAS_BG = '#1e1915';
const GB_IDLE = 'Create Art changes the whole collage with your prompt';

class GalleryBuilder {
  constructor(gallery) {
    this.gallery = gallery;
    this.root = el('div', 'gb');
    this.pieces = [];
    this.selected = null;
    this.undoStack = [];
    this.busy = false;
    this.scale = 0.2;
    try { const s = JSON.parse(localStorage.getItem('galleryCanvas') || 'null'); if (Array.isArray(s?.pieces)) this.pieces = s.pieces; } catch { /* fresh */ }

    const top = el('div', 'gb-top');
    this.info = el('span', 'gb-info');
    const tool = (label, title, fn) => { const b = el('button', 'icon gb-tool', label); b.type = 'button'; b.title = title; b.onclick = fn; return b; };
    this.undoBtn = tool('↶', 'Undo (Ctrl+Z)', () => this.undo());
    this.downBtn = tool('▼', 'Move down a layer ([)', () => this.layer(-1));
    this.upBtn = tool('▲', 'Move up a layer (])', () => this.layer(1));
    this.delBtn = tool('✕', 'Remove the piece (Delete)', () => this.remove());
    this.clearBtn = el('button', 'gallery-action', 'Clear');
    this.clearBtn.type = 'button';
    this.clearBtn.title = 'Take every piece off the canvas (Undo brings them back)';
    this.clearBtn.onclick = () => { if (!this.pieces.length || this.busy) return; this.snapshot(); this.pieces = []; this.selected = null; this.changed(); };
    top.append(this.info, this.undoBtn, this.downBtn, this.upBtn, this.delBtn, this.clearBtn);

    this.stage = el('div', 'gb-stage');
    this.frame = el('div', 'gb-frame');
    this.board = el('div', 'gb-board');
    this.board.style.width = CANVAS_W + 'px';
    this.board.style.height = CANVAS_H + 'px';
    this.hint = el('div', 'gb-hint', 'Drag images from the gallery here');
    this.working = el('div', 'gb-working hidden');
    this.frame.append(this.board, this.hint, this.working);
    this.stage.append(this.frame);
    this.board.addEventListener('pointerdown', e => { if (e.target === this.board) this.select(null); });
    this.stage.addEventListener('pointerdown', e => { if (e.target === this.stage) this.select(null); });
    // Library images dropped on the canvas.
    const ours = e => [...(e.dataTransfer?.types || [])].includes('application/x-gallery-image');
    this.stage.addEventListener('dragover', e => { if (ours(e) && !this.busy) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; this.frame.classList.add('drop'); } });
    this.stage.addEventListener('dragleave', e => { if (!this.stage.contains(e.relatedTarget)) this.frame.classList.remove('drop'); });
    this.stage.addEventListener('drop', e => {
      if (!ours(e)) return;
      e.preventDefault();
      this.frame.classList.remove('drop');
      let img;
      try { img = JSON.parse(e.dataTransfer.getData('application/x-gallery-image')); } catch { return; }
      const r = this.board.getBoundingClientRect();
      this.add(img, { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale });
    });

    // The prompt, like the message box.
    const box = el('div', 'tickets-assist gb-prompt');
    this.chips = el('div', 'gb-chips');
    const row = el('div', 'tickets-assist-row');
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'tickets-assist-input';
    this.input.placeholder = 'Make it a cozy night scene, warm candle light';
    this.input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); this.create(); } };
    this.createBtn = el('button', 'primary tickets-assist-send', 'Create');
    this.createBtn.type = 'button';
    this.createBtn.onclick = () => this.create();
    const under = el('div', 'tickets-assist-bar');
    this.status = el('span', 'tickets-assist-hint', GB_IDLE);
    under.append(el('span', 'tickets-assist-mark', 'Create Art'), this.status, this.createBtn);
    row.append(this.input, under);
    box.append(this.chips, row);

    this.root.append(top, this.stage, box);
    new ResizeObserver(() => this.fit()).observe(this.stage);
    document.addEventListener('keydown', e => this.onKey(e), true);
    this.render();
  }

  // The board as big as the stage allows.
  fit() {
    const h = this.stage.clientHeight - 16;
    if (h <= 40) return;
    this.scale = h / CANVAS_H;
    this.board.style.transform = `scale(${this.scale})`;
    this.frame.style.width = Math.round(CANVAS_W * this.scale) + 'px';
    this.frame.style.height = Math.round(CANVAS_H * this.scale) + 'px';
    // Handles and outlines keep their size on screen.
    this.board.style.setProperty('--inv', String(1 / this.scale));
  }

  snapshot() {
    this.undoStack.push(JSON.stringify(this.pieces));
    if (this.undoStack.length > 60) this.undoStack.shift();
  }
  undo() {
    if (this.busy || !this.undoStack.length) return;
    this.pieces = JSON.parse(this.undoStack.pop());
    if (!this.pieces.some(p => p.id === this.selected)) this.selected = null;
    this.changed();
  }
  changed() {
    try { localStorage.setItem('galleryCanvas', JSON.stringify({ pieces: this.pieces })); } catch { /* this run only */ }
    this.render();
  }

  // A library image onto the canvas, centred on at (or the canvas's middle):
  // at its own size, smaller when it does not fit. One as big as the canvas
  // (a background) fills it and goes under everything else.
  async add(img, at) {
    if (this.busy) return;
    const size = await new Promise(resolve => {
      const probe = new Image();
      probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
      probe.onerror = () => resolve(null);
      probe.src = mediaUrl(img.path);
    });
    if (!size?.w) return this.gallery.flash(`Could not read ${img.name}.`);
    const fill = size.w >= CANVAS_W * 0.95 || size.h >= CANVAS_H * 0.95;
    let w, h;
    if (fill) {
      w = Math.round(Math.max(CANVAS_W, CANVAS_H * size.w / size.h));
      h = Math.round(w * size.h / size.w);
    } else {
      const k = Math.min(1, (CANVAS_W * 0.9) / size.w, (CANVAS_H * 0.9) / size.h);
      w = Math.round(size.w * k);
      h = Math.round(size.h * k);
    }
    const c = at || { x: CANVAS_W / 2, y: CANVAS_H / 2 };
    this.snapshot();
    const p = {
      id: Math.random().toString(36).slice(2), path: img.path, name: img.name, mtime: img.mtime || 0, w, h,
      x: Math.round(fill ? (CANVAS_W - w) / 2 : c.x - w / 2), y: Math.round(fill ? (CANVAS_H - h) / 2 : c.y - h / 2),
    };
    if (fill) this.pieces.unshift(p); else this.pieces.push(p);
    this.selected = p.id;
    if (document.activeElement?.matches?.('input, textarea')) document.activeElement.blur();
    window.uiSound?.('attach');
    this.changed();
  }

  select(id) {
    if (id && document.activeElement?.matches?.('input, textarea')) document.activeElement.blur();
    if (this.selected === id) return;
    this.selected = id;
    this.render();
  }
  remove(id = this.selected) {
    if (this.busy || !id) return;
    this.snapshot();
    this.pieces = this.pieces.filter(p => p.id !== id);
    if (this.selected === id) this.selected = null;
    this.changed();
  }
  layer(dir) {
    const i = this.pieces.findIndex(p => p.id === this.selected);
    const j = i + dir;
    if (this.busy || i < 0 || j < 0 || j >= this.pieces.length) return;
    this.snapshot();
    [this.pieces[i], this.pieces[j]] = [this.pieces[j], this.pieces[i]];
    this.changed();
  }

  onKey(e) {
    if (this.gallery.view.classList.contains('hidden') || document.querySelector('.gallery-preview')) return;
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
    const p = this.pieces.find(x => x.id === this.selected);
    if (!p) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.remove(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.select(null); }
    else if (e.key === '[' || e.key === ']') { e.preventDefault(); this.layer(e.key === ']' ? 1 : -1); }
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (this.busy) return;
      if (!e.repeat) this.snapshot();
      const d = e.shiftKey ? 20 : 2;
      if (e.key === 'ArrowLeft') p.x -= d; else if (e.key === 'ArrowRight') p.x += d;
      else if (e.key === 'ArrowUp') p.y -= d; else p.y += d;
      this.changed();
    }
  }

  render() {
    this.board.replaceChildren();
    for (const p of this.pieces) {
      const node = el('div', 'gb-piece' + (p.id === this.selected ? ' on' : ''));
      Object.assign(node.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px' });
      const pic = document.createElement('img');
      pic.src = `${mediaUrl(p.path)}&v=${Math.round(p.mtime || 0)}`;
      pic.draggable = false;
      pic.onerror = () => node.classList.add('missing');
      node.title = p.name;
      node.append(pic);
      node.addEventListener('pointerdown', e => this.drag(e, p, null));
      if (p.id === this.selected) for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const h = el('span', `gb-handle ${corner}`);
        h.addEventListener('pointerdown', e => { e.stopPropagation(); this.drag(e, p, corner); });
        node.append(h);
      }
      this.board.append(node);
    }
    this.hint.classList.toggle('hidden', !!this.pieces.length);
    const sel = this.pieces.find(p => p.id === this.selected);
    this.info.textContent = `${CANVAS_W} × ${CANVAS_H} · ${this.pieces.length} piece${this.pieces.length === 1 ? '' : 's'}`;
    this.undoBtn.disabled = !this.undoStack.length || this.busy;
    for (const b of [this.downBtn, this.upBtn, this.delBtn]) b.disabled = !sel || this.busy;
    this.clearBtn.disabled = !this.pieces.length || this.busy;
    this.chips.replaceChildren(...[...this.pieces].reverse().map(p => {
      const c = el('button', 'gb-chip' + (p.id === this.selected ? ' on' : ''), p.name.replace(/\.[^.]+$/, ''));
      c.type = 'button';
      c.title = 'Select it on the canvas';
      c.onclick = () => this.select(p.id);
      return c;
    }));
    this.chips.classList.toggle('hidden', !this.pieces.length);
  }

  // Moves a piece, or resizes it from a corner keeping its shape.
  drag(e, p, corner) {
    if (this.busy || e.button !== 0) return;
    e.preventDefault();
    // The keys (Delete, arrows, [ ]) are for the canvas now, not the search box.
    if (document.activeElement?.matches?.('input, textarea')) document.activeElement.blur();
    const target = e.currentTarget;
    if (this.selected !== p.id) {
      this.selected = p.id;
      this.render();
    }
    const node = this.board.children[this.pieces.indexOf(p)];
    const grab = corner ? node?.querySelector(`.gb-handle.${corner}`) : node;
    if (!grab) return;
    const start = { x: e.clientX, y: e.clientY, p: { ...p } };
    let moved = false;
    try { grab.setPointerCapture(e.pointerId); } catch { /* fine */ }
    const move = ev => {
      const dx = (ev.clientX - start.x) / this.scale;
      const dy = (ev.clientY - start.y) / this.scale;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      if (!moved) { moved = true; this.snapshot(); }
      if (!corner) {
        p.x = Math.round(start.p.x + dx);
        p.y = Math.round(start.p.y + dy);
      } else {
        const ratio = start.p.h / start.p.w;
        const sx = corner.includes('e') ? 1 : -1;
        const sy = corner.includes('s') ? 1 : -1;
        // The bigger of the two pulls decides, so the corner follows the pointer.
        const grow = Math.max(sx * dx, sy * dy / ratio);
        const w = Math.max(24, Math.round(start.p.w + grow));
        const h = Math.round(w * ratio);
        p.w = w;
        p.h = h;
        p.x = sx > 0 ? start.p.x : start.p.x + start.p.w - w;
        p.y = sy > 0 ? start.p.y : start.p.y + start.p.h - h;
      }
      Object.assign(node.style, { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px' });
    };
    const up = () => {
      grab.removeEventListener('pointermove', move);
      grab.removeEventListener('pointerup', up);
      grab.removeEventListener('pointercancel', up);
      if (moved) this.changed();
    };
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', up);
    grab.addEventListener('pointercancel', up);
    void target;
  }

  // The collage at full size, as a JPEG data: URL.
  async flatten() {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const g = canvas.getContext('2d');
    g.fillStyle = CANVAS_BG;
    g.fillRect(0, 0, CANVAS_W, CANVAS_H);
    for (const p of this.pieces) {
      const data = await window.deck.galleryData(p.path);
      if (!data) throw new Error(`${p.name} is not in the gallery any more.`);
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error(`Could not read ${p.name}.`)); img.src = data; });
      g.drawImage(img, p.x, p.y, p.w, p.h);
    }
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  async create() {
    if (this.busy) return;
    const prompt = this.input.value.trim();
    if (!this.pieces.length) { this.gallery.flash('Drag images from the gallery onto the canvas first.'); window.uiSound?.('refuse'); return; }
    if (!prompt) { this.input.focus(); this.input.placeholder = 'Say what Create Art should change'; window.uiSound?.('refuse'); return; }
    this.busy = true;
    this.root.classList.add('busy');
    this.createBtn.textContent = 'Creating…';
    this.working.replaceChildren(el('div', 'gb-spinner'), el('div', null, 'Create Art is working on it. This takes a minute or two.'));
    this.working.classList.remove('hidden');
    this.render();
    const started = Date.now();
    this.status.textContent = 'Creating…';
    const tick = setInterval(() => { this.status.textContent = `Creating… ${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
    let r;
    try {
      const image = await this.flatten();
      r = await window.deck.galleryCreate({ image, prompt, width: CANVAS_W, height: CANVAS_H });
    } catch (err) { r = { error: String(err?.message || err) }; }
    clearInterval(tick);
    this.busy = false;
    this.root.classList.remove('busy');
    this.createBtn.textContent = 'Create';
    this.working.classList.add('hidden');
    if (!r || r.error) {
      this.status.textContent = GB_IDLE;
      this.gallery.flash(r?.error || 'Create Art made no image.');
      window.uiSound?.('refuse');
      this.render();
      return;
    }
    // What came back replaces the collage; Undo brings the collage back.
    this.snapshot();
    const name = r.path.split(/[\\/]/).pop();
    this.pieces = [{ id: Math.random().toString(36).slice(2), path: r.path, name, mtime: Date.now(), x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }];
    this.selected = null;
    this.status.textContent = `Saved as Created / ${name}`;
    window.uiSound?.('done');
    this.changed();
    this.gallery.load(false, { quiet: true });
  }
}

window.GalleryBuilder = GalleryBuilder;
