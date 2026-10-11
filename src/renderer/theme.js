// The app's look (Settings → Theme). "default" is the app's own look;
// "mother" is the retro terminal of Alien (theme-mother.css), which also
// gets the moving parts of an old tube here: static, a rolling band, now and
// then a sync glitch, and a power-on when the theme starts.
//
// The choice lives in config.json; a copy in localStorage lets the window
// open in the right look before the config arrives.

const THEMES = [['default', 'Default'], ['mother', 'MU-TH-UR · retro terminal']];
const crt = { glitch: 0, curved: true };

// curved: bend the picture like the glass of a tube (Settings → Curved screen).
function applyTheme(name, { powerOn = true, curved } = {}) {
  const theme = THEMES.some(([v]) => v === name) ? name : 'default';
  if (curved !== undefined) {
    crt.curved = curved;
    try { localStorage.setItem('curvedScreen', curved ? '1' : '0'); } catch { /* it still applies */ }
  }
  const was = document.documentElement.dataset.theme || 'default';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch { /* the theme still applies */ }
  document.getElementById('theme-mother').disabled = theme !== 'mother';
  if (theme === 'mother') startTube({ powerOn: powerOn && was !== 'mother' });
  else stopTube();
}

function startTube({ powerOn }) {
  for (const id of ['mu-roll', 'mu-noise', 'mu-streak']) {
    if (document.getElementById(id)) continue;
    const layer = document.createElement('div');
    layer.id = id;
    document.body.appendChild(layer);
  }
  // Static: a small tile of noise that jumps around.
  const noise = document.getElementById('mu-noise');
  if (!noise.style.backgroundImage) {
    const c = document.createElement('canvas');
    c.width = c.height = 180;
    const g = c.getContext('2d');
    const img = g.createImageData(180, 180);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    noise.style.backgroundImage = `url(${c.toDataURL()})`;
  }
  const main = document.getElementById('main');
  document.documentElement.classList.toggle('mu-curved', crt.curved);
  if (crt.curved) {
    drawGlass();
    window.addEventListener('resize', onResize);
  } else {
    clearGlass();
    window.removeEventListener('resize', onResize);
  }
  clearInterval(crt.glitch);
  // Now and then (about every half minute) the picture slips a hair sideways.
  crt.glitch = setInterval(() => {
    if (document.hidden || Math.random() < 0.5) return;
    replayClass(main, 'mu-glitch', 300);
  }, 15000);
  if (powerOn) {
    replayClass(main, 'mu-on', 1000);
    window.uiSound?.('powerOn');
  }
}

function stopTube() {
  clearInterval(crt.glitch);
  for (const id of ['mu-roll', 'mu-noise', 'mu-streak']) document.getElementById(id)?.remove();
  document.getElementById('main')?.classList.remove('mu-glitch', 'mu-on');
  document.documentElement.classList.remove('mu-curved');
  clearGlass();
  window.removeEventListener('resize', onResize);
}

// Curved glass. Bending the app's own picture (an SVG filter) had to be
// drawn again for every change under it: typing lagged and anything that
// moved dropped to a third of the frame rate on a large window. Instead,
// still pictures drawn once (again when the window's size changes) give the
// curve: the screen has a tube's bulging shape, with its sides bowing out
// and its corners pulled in, behind a bezel; the scanlines bow with the
// glass, and so do the lines of the grid behind everything. The app itself
// stays flat and as fast as without the theme.
const BOW = 0.018;   // how far the corners are pulled in, as a share of the screen's size
function drawGlass() {
  const main = document.getElementById('main');
  const box = main.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth, H = innerHeight;
  const key = `${W}x${H}@${dpr}`;
  let glass = document.getElementById('mu-glass');
  if (glass && glass.dataset.key === key) return;
  if (!glass) {
    glass = document.createElement('canvas');
    glass.id = 'mu-glass';
    document.body.appendChild(glass);
  }
  glass.dataset.key = key;
  glass.width = Math.round(W * dpr);
  glass.height = Math.round(H * dpr);
  const g = glass.getContext('2d');
  g.scale(dpr, dpr);

  const x0 = box.left, y0 = box.top, x1 = box.right, y1 = box.bottom;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  const bow = BOW * Math.min(hw, hh) * 2;
  // A point of the picture as the curved glass shows it: lines bow outwards,
  // most in the middle of the screen. u, v from -1 to 1.
  const at = (u, v) => [cx + u * (hw - bow * (v * v)), cy + v * (hh - bow * (u * u))];

  // The screen's outline: the four bowed sides, with round corners.
  const N = 48, R = 26;
  const side = [];
  for (let i = 0; i <= N; i++) side.push(at(-1 + (2 * i) / N, -1));       // top, left to right
  const right = [], bottom = [], left = [];
  for (let i = 0; i <= N; i++) right.push(at(1, -1 + (2 * i) / N));
  for (let i = 0; i <= N; i++) bottom.push(at(1 - (2 * i) / N, 1));
  for (let i = 0; i <= N; i++) left.push(at(-1, 1 - (2 * i) / N));
  const outline = new Path2D();
  const edges = [side, right, bottom, left];
  outline.moveTo(...side[N >> 1]);
  for (let e = 0; e < 4; e++) {
    const pts = edges[e], next = edges[(e + 1) % 4];
    for (let i = (e === 0 ? (N >> 1) + 1 : 1); i < N; i++) outline.lineTo(...pts[i]);
    outline.arcTo(...pts[N], ...next[1], R);
  }
  for (let i = 1; i <= (N >> 1); i++) outline.lineTo(...side[i]);
  outline.closePath();

  // The scanlines, bowing with the glass, inside the screen.
  g.save();
  g.clip(outline);
  g.strokeStyle = 'rgba(0, 0, 0, 0.16)';
  g.lineWidth = 1;
  const rows = Math.ceil((y1 - y0) / 3);
  g.beginPath();
  for (let r = 0; r <= rows; r++) {
    const v = -1 + (2 * r) / rows;
    for (let i = 0; i <= 24; i++) {
      const [x, y] = at(-1 + i / 12, v);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
  }
  g.stroke();
  // The glass darkens where it turns away from you, along its curve.
  const shade = g.createRadialGradient(cx, cy, Math.min(hw, hh) * 0.75, cx, cy, Math.hypot(hw, hh));
  shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  shade.addColorStop(0.6, 'rgba(0, 0, 0, 0.28)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.8)');
  g.fillStyle = shade;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.restore();

  // The bezel: everything outside the screen, dark plastic.
  g.save();
  const frame = new Path2D();
  frame.rect(0, 0, W, H);
  frame.addPath(outline);
  const plastic = g.createLinearGradient(0, 0, 0, H);
  plastic.addColorStop(0, '#151816');
  plastic.addColorStop(1, '#090a09');
  g.fillStyle = plastic;
  g.fill(frame, 'evenodd');
  // Its inner lip catches a little light at the top, and throws shadow in.
  g.clip(outline);
  g.shadowColor = 'rgba(0, 0, 0, 0.95)';
  g.shadowBlur = 22;
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  g.stroke(outline);
  g.restore();
  g.lineWidth = 1.2;
  g.strokeStyle = 'rgba(160, 230, 240, 0.10)';
  g.stroke(outline);

  // The grid behind everything, bowing the same way.
  const views = document.getElementById('views');
  const vb = views.getBoundingClientRect();
  const grid = document.createElement('canvas');
  grid.width = Math.round(vb.width * dpr);
  grid.height = Math.round(vb.height * dpr);
  const gg = grid.getContext('2d');
  gg.scale(dpr, dpr);
  gg.translate(-vb.left, -vb.top);
  gg.strokeStyle = 'rgba(70, 220, 240, 0.05)';
  gg.lineWidth = 1;
  gg.beginPath();
  const step = 56;
  for (let x = x0; x <= x1; x += step) {
    const u = (x - cx) / hw;
    for (let i = 0; i <= 24; i++) { const [px, py] = at(u, -1 + i / 12); if (i) gg.lineTo(px, py); else gg.moveTo(px, py); }
  }
  for (let y = y0; y <= y1; y += step) {
    const v = (y - cy) / hh;
    for (let i = 0; i <= 24; i++) { const [px, py] = at(-1 + i / 12, v); if (i) gg.lineTo(px, py); else gg.moveTo(px, py); }
  }
  gg.stroke();
  views.style.backgroundImage = `url(${grid.toDataURL()})`;
  views.style.backgroundSize = '100% 100%';
}

function clearGlass() {
  document.getElementById('mu-glass')?.remove();
  const views = document.getElementById('views');
  if (views) { views.style.backgroundImage = ''; views.style.backgroundSize = ''; }
}

let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawGlass, 150);
}

// The theme shows everything in capitals (text-transform), and a copy would
// take the capitals along. In the theme, a copy takes the text as written.
document.addEventListener('copy', e => {
  if (document.documentElement.dataset.theme !== 'mother') return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-100000px;top:0;width:800px;text-transform:none';
  for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
  for (const n of box.querySelectorAll('*')) n.style.textTransform = 'none';
  document.body.appendChild(box);
  const text = box.innerText;
  box.remove();
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
});

function replayClass(node, name, ms) {
  node.classList.remove(name);
  void node.offsetWidth;
  node.classList.add(name);
  setTimeout(() => node.classList.remove(name), ms);
}

// Before anything is drawn: the look you had last time.
try {
  crt.curved = localStorage.getItem('curvedScreen') !== '0';
  applyTheme(localStorage.getItem('theme') || 'default');
} catch { applyTheme('default'); }
