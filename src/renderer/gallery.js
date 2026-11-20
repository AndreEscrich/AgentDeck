// The Gallery (the picture button on the Hub's left side): your game's art
// library, a Google Drive folder set in Settings → Gallery (src/gallery.js).
// Each folder in it is a category. You can filter by category and by name,
// open an image large, and pick images to send to an agent as references:
// Use as reference puts them on the Hub's message box, like dropped images.
//
// The view shows what is in Drive: New folder makes a category, + Add images
// (or images dropped on a category) copies images into it, and Drive for
// desktop uploads them. Changes in the folder, yours or ones Drive brings
// from others, show by themselves.
//
// The library takes the whole left side. On the right is the builder
// (gallerybuilder.js): a canvas you drag images onto to make a collage, and
// a prompt under it that changes the collage with Create Art.

const THUMB_SIZE = 320;

class GalleryView {
  // onUse(paths): the images you picked, for the Hub's message box.
  constructor({ onUse, onOpenSettings }) {
    this.onUse = onUse;
    this.onOpenSettings = onOpenSettings;
    this.view = el('div', 'view gallery-view hidden');
    $('views').appendChild(this.view);
    const bar = el('div', 'gallery-bar');
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.placeholder = 'Search images…';
    this.search.className = 'gallery-search';
    this.search.oninput = () => this.renderGrid();
    this.cats = el('div', 'gallery-cats');
    const refresh = el('button', 'icon gallery-refresh', '↻');
    refresh.type = 'button';
    refresh.title = 'Read the folder again';
    refresh.onclick = () => this.load(false);
    this.useBtn = el('button', 'gallery-use hidden');
    this.useBtn.type = 'button';
    this.useBtn.onclick = () => this.use([...this.picked]);
    this.clearBtn = el('button', 'gallery-clear hidden', 'Clear');
    this.clearBtn.type = 'button';
    this.clearBtn.onclick = () => { this.picked.clear(); this.renderGrid(); };
    this.newFolderBtn = el('button', 'gallery-action', '+ New folder');
    this.newFolderBtn.type = 'button';
    this.newFolderBtn.title = 'Make a category: a folder in the Drive folder';
    this.newFolderBtn.onclick = () => this.askFolderName();
    this.driveLink = el('a', 'gallery-action gallery-drive hidden', 'Open in Drive');
    this.driveLink.target = '_blank';
    bar.append(this.search, this.cats, this.newFolderBtn, this.clearBtn, this.useBtn, this.driveLink, refresh);
    this.bar = bar;
    window.deck.onGalleryChanged?.(() => { if (this.data) this.load(false, { quiet: true }); });
    this.main = el('section', 'gallery-main scroll');
    const left = el('div', 'gallery-left');
    left.append(bar, this.main);
    this.builder = new GalleryBuilder(this);
    this.view.append(left, this.builder.root);
    this.data = null;
    this.category = null;   // null: every category
    this.picked = new Set();   // image paths
    this.loaded = null;   // the settings the list was read with
  }

  // Shows the view; reads the folder the first time, or after the settings changed.
  open(settingsKey) {
    const url = (() => { try { return JSON.parse(settingsKey)[0]; } catch { return ''; } })();
    this.driveLink.href = /^https:\/\/drive\.google\.com\//.test(url) ? url : '#';
    this.driveLink.classList.toggle('hidden', !/^https:\/\/drive\.google\.com\//.test(url));
    if (settingsKey !== this.loaded) {
      this.loaded = settingsKey;
      this.picked.clear();
      this.category = null;
      this.data = null;
      this.load(false);
    } else if (this.data) this.load(false, { quiet: true });
    requestAnimationFrame(() => { this.search.focus(); this.builder.fit(); });
  }

  // quiet: read it again without the "Reading" note (it keeps the scroll).
  async load(again, { quiet = false } = {}) {
    if (!quiet) this.main.replaceChildren(el('div', 'gallery-note', again ? 'Finding the folder in Google Drive…' : 'Reading the gallery…'));
    const slow = setTimeout(() => {
      if (!this.data) this.main.replaceChildren(el('div', 'gallery-note', 'Asking Google Drive where the folder is. This takes a few seconds the first time.'));
    }, 1500);
    let data;
    try { data = await window.deck.galleryList(again); } catch (err) { data = { error: String(err?.message || err) }; }
    clearTimeout(slow);
    if (quiet && data.error) return;
    this.data = data.error ? null : data;
    if (data.error) return this.showError(data.error);
    // A category that is gone: back to All.
    if (this.category !== null && !data.categories.some(c => c.name === this.category)) this.category = null;
    const scroll = this.main.scrollTop;
    this.renderCats();
    this.renderGrid();
    if (quiet) this.main.scrollTop = scroll;
  }

  // New folder: the button turns into a name field; ↩ makes the folder.
  askFolderName() {
    if (!this.data) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gallery-folder-name';
    input.placeholder = 'Folder name, ↩ to make it';
    const done = () => { input.replaceWith(this.newFolderBtn); };
    input.onkeydown = async e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return done();
      const r = await window.deck.galleryMakeFolder(name);
      if (r.error) { input.value = ''; input.placeholder = r.error; window.uiSound?.('refuse'); return; }
      done();
      this.category = r.name;
      await this.load(false, { quiet: true });
    };
    input.onblur = () => setTimeout(() => { if (input.isConnected) done(); }, 150);
    this.newFolderBtn.replaceWith(input);
    input.focus();
  }

  // Copies images into a category: files are paths (dropped ones), or none
  // to pick them in a file dialog.
  async addTo(category, files) {
    const r = await window.deck.galleryAdd(category, files);
    if (r.error) return this.flash(r.error);
    if (r.skipped?.length) this.flash(`Only PNG, JPG, WebP and GIF images can be added (${r.skipped.join(', ')} skipped).`);
    if (r.added?.length) { window.uiSound?.('attach'); await this.load(false, { quiet: true }); }
  }

  flash(text) {
    const note = el('div', 'gallery-flash', text);
    this.view.appendChild(note);
    setTimeout(() => note.remove(), 4000);
  }

  showError(text) {
    const box = el('div', 'gallery-note gallery-error');
    box.append(el('div', null, text));
    const row = el('div', 'gallery-note-actions');
    const settings = el('button', null, 'Open Settings');
    settings.type = 'button';
    settings.onclick = () => this.onOpenSettings?.();
    const again = el('button', null, 'Try again');
    again.type = 'button';
    again.onclick = () => this.load(true);
    row.append(settings, again);
    box.append(row);
    this.main.replaceChildren(box);
    this.cats.replaceChildren();
  }

  renderCats() {
    this.cats.replaceChildren();
    const cats = this.data?.categories || [];
    const chip = (label, value, count) => {
      const b = el('button', 'gallery-cat' + (this.category === value ? ' on' : ''));
      b.type = 'button';
      b.append(el('span', null, label), el('span', 'gallery-cat-count', String(count)));
      b.onclick = () => { this.category = value; this.renderCats(); this.renderGrid(); };
      this.cats.appendChild(b);
    };
    chip('All', null, cats.reduce((n, c) => n + c.images.length, 0));
    for (const c of cats) chip(c.name || 'Other', c.name, c.images.length);
  }

  renderGrid() {
    if (!this.data) return;
    const q = this.search.value.trim().toLowerCase();
    const cats = this.data.categories.filter(c => this.category === null || c.name === this.category);
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const c of cats) {
      const images = c.images.filter(i => !q || `${c.name}/${i.sub}/${i.name}`.toLowerCase().includes(q));
      if (!images.length && q) continue;
      const section = el('section', 'gallery-section');
      const head = el('div', 'gallery-head');
      const add = el('button', 'gallery-add', '+ Add images');
      add.type = 'button';
      add.title = `Copy images into ${c.name || 'the Drive folder'}; Drive uploads them. You can also drop images here.`;
      add.onclick = () => this.addTo(c.name);
      head.append(el('h3', 'gallery-heading', c.name || 'Other'), add);
      section.append(head);
      this.dropTarget(section, c.name);
      const grid = el('div', 'gallery-grid');
      if (!images.length) grid.append(el('div', 'gallery-empty', 'No images in this folder yet. Drop images here, or use + Add images.'));
      for (const img of images) grid.appendChild(this.tile(img, c.name));
      shown += images.length;
      section.append(grid);
      frag.appendChild(section);
    }
    if (!this.data.categories.length) frag.appendChild(el('div', 'gallery-note', `The folder has no images yet. Put PNG files into folders inside ${this.data.folder}; each folder is a category.`));
    else if (!shown && q) frag.appendChild(el('div', 'gallery-note', `No image matches “${this.search.value.trim()}”.`));
    if (this.data.truncated) frag.appendChild(el('div', 'gallery-note', 'The gallery shows the first 3000 images.'));
    this.main.replaceChildren(frag);
    this.renderPicked();
  }

  // Images dropped on a category's section are copied into its folder.
  dropTarget(section, category) {
    const files = e => [...(e.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    section.addEventListener('dragenter', e => { if (files(e)) { depth++; section.classList.add('drop'); } });
    section.addEventListener('dragleave', e => { if (files(e) && --depth <= 0) { depth = 0; section.classList.remove('drop'); } });
    section.addEventListener('dragover', e => { if (files(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    section.addEventListener('drop', e => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      section.classList.remove('drop');
      const paths = [...e.dataTransfer.files].map(f => window.deck.pathForFile?.(f)).filter(Boolean);
      if (paths.length) this.addTo(category, paths);
    });
  }

  tile(img, category) {
    const tile = el('div', 'gallery-tile' + (this.picked.has(img.path) ? ' picked' : ''));
    tile.title = [category, img.sub, img.name].filter(Boolean).join(' / ');
    const pic = document.createElement('img');
    pic.loading = 'lazy';
    pic.decoding = 'async';
    pic.src = `${mediaUrl(img.path)}&thumb=${THUMB_SIZE}&v=${Math.round(img.mtime)}`;
    pic.alt = img.name;
    const box = el('div', 'gallery-pic');
    box.appendChild(pic);
    const check = el('button', 'gallery-check');
    check.type = 'button';
    check.title = 'Pick it as a reference';
    check.onclick = e => {
      e.stopPropagation();
      if (this.picked.has(img.path)) this.picked.delete(img.path); else this.picked.add(img.path);
      tile.classList.toggle('picked', this.picked.has(img.path));
      window.uiSound?.('tick');
      this.renderPicked();
    };
    tile.append(box, check, el('div', 'gallery-name', img.name.replace(/\.[^.]+$/, '')));
    tile.onclick = () => this.preview(img, category);
    // Dragged onto the canvas, it becomes a piece of the collage.
    tile.draggable = true;
    tile.ondragstart = e => {
      e.dataTransfer.setData('application/x-gallery-image', JSON.stringify({ path: img.path, name: img.name, mtime: img.mtime }));
      e.dataTransfer.effectAllowed = 'copy';
      const pic = tile.querySelector('img');
      if (pic?.complete && pic.naturalWidth) e.dataTransfer.setDragImage(pic, pic.width / 2, pic.height / 2);
    };
    return tile;
  }

  renderPicked() {
    const n = this.picked.size;
    this.useBtn.classList.toggle('hidden', !n);
    this.clearBtn.classList.toggle('hidden', !n);
    this.useBtn.textContent = n === 1 ? 'Use 1 as reference' : `Use ${n} as references`;
  }

  // The image large, with its size and Use as reference.
  preview(img, category) {
    const overlay = el('div', 'gallery-preview');
    const pic = document.createElement('img');
    pic.src = mediaUrl(img.path);
    const info = el('div', 'gallery-preview-info');
    const name = el('div', 'gallery-preview-name', img.name);
    const meta = el('div', 'gallery-preview-meta', [category || 'Other', img.sub].filter(Boolean).join(' / '));
    pic.onload = () => { meta.textContent += ` · ${pic.naturalWidth} × ${pic.naturalHeight} · ${(img.size / 1024 / 1024).toFixed(1)} MB`; };
    const actions = el('div', 'gallery-preview-actions');
    const use = el('button', 'gallery-use', 'Use as reference');
    use.type = 'button';
    use.onclick = () => { close(); this.use([img.path]); };
    const reveal = el('button', null, IS_MAC ? 'Show in Finder' : 'Show in Explorer');
    reveal.type = 'button';
    reveal.onclick = () => window.deck.revealFile(img.path);
    const toCanvas = el('button', null, 'Add to canvas');
    toCanvas.type = 'button';
    toCanvas.onclick = () => { close(); this.builder.add({ path: img.path, name: img.name, mtime: img.mtime }); };
    actions.append(use, toCanvas, reveal);
    info.append(name, meta, actions);
    overlay.append(pic, info);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } };
    overlay.onclick = e => { if (e.target === overlay) close(); };
    document.addEventListener('keydown', onKey, true);
    this.view.appendChild(overlay);
  }

  use(paths) {
    if (!paths.length) return;
    this.picked.clear();
    this.renderGrid();
    this.onUse?.(paths);
  }
}

window.GalleryView = GalleryView;
