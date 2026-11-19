// The Gallery (the picture button on the Hub's left side): your game's art
// library, a Google Drive folder set in Settings → Gallery (src/gallery.js).
// Each folder in it is a category. You can filter by category and by name,
// open an image large, and pick images to send to an agent as references:
// Use as reference puts them on the Hub's message box, like dropped images.

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
    bar.append(this.search, this.cats, this.clearBtn, this.useBtn, refresh);
    this.main = el('section', 'gallery-main scroll');
    this.view.append(bar, this.main);
    this.data = null;
    this.category = null;   // null: every category
    this.picked = new Set();   // image paths
    this.loaded = null;   // the settings the list was read with
  }

  // Shows the view; reads the folder the first time, or after the settings changed.
  open(settingsKey) {
    if (settingsKey !== this.loaded) {
      this.loaded = settingsKey;
      this.picked.clear();
      this.category = null;
      this.load(false);
    }
    requestAnimationFrame(() => this.search.focus());
  }

  async load(again) {
    this.main.replaceChildren(el('div', 'gallery-note', again ? 'Finding the folder in Google Drive…' : 'Reading the gallery…'));
    const slow = setTimeout(() => {
      if (!this.data) this.main.replaceChildren(el('div', 'gallery-note', 'Asking Google Drive where the folder is. This takes a few seconds the first time.'));
    }, 1500);
    let data;
    try { data = await window.deck.galleryList(again); } catch (err) { data = { error: String(err?.message || err) }; }
    clearTimeout(slow);
    this.data = data.error ? null : data;
    if (data.error) return this.showError(data.error);
    this.renderCats();
    this.renderGrid();
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
      if (!images.length && (q || this.category === null)) continue;
      const section = el('section', 'gallery-section');
      section.append(el('h3', 'gallery-heading', c.name || 'Other'));
      const grid = el('div', 'gallery-grid');
      if (!images.length) grid.append(el('div', 'gallery-empty', 'No images in this folder yet.'));
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
    actions.append(use, reveal);
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
