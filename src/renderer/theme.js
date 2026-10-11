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
  if (crt.curved) {
    bendGlass();
    window.addEventListener('resize', onResize);
  } else {
    main.classList.remove('mu-curve');
    window.removeEventListener('resize', onResize);
  }
  document.documentElement.classList.toggle('mu-curved', crt.curved);
  clearInterval(crt.glitch);
  crt.glitch = setInterval(() => {
    if (document.hidden || Math.random() < 0.5) return;
    replayClass(main, 'mu-glitch', 300);
  }, 6000);
  if (powerOn) {
    replayClass(main, 'mu-on', 1000);
    window.uiSound?.('powerOn');
  }
}

function stopTube() {
  clearInterval(crt.glitch);
  for (const id of ['mu-roll', 'mu-noise', 'mu-streak', 'mu-glass']) document.getElementById(id)?.remove();
  document.getElementById('main')?.classList.remove('mu-glitch', 'mu-on', 'mu-curve');
  window.removeEventListener('resize', onResize);
  crt.mapSize = null;
}

// Curved glass: an SVG filter moves each pixel of the window outwards, more
// towards the corners, as a bulging tube shows its picture. The map that
// says how far is drawn for the window's size, again when that changes.
const BEND = 0.022;   // how far the corners move, as a share of the window
function bendGlass() {
  const main = document.getElementById('main');
  const box = main.getBoundingClientRect();
  const w = Math.round(box.width), h = Math.round(box.height);
  if (!w || !h) return;
  if (crt.mapSize !== `${w}x${h}`) {
    crt.mapSize = `${w}x${h}`;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const v = (y / (h - 1)) * 2 - 1;
      for (let x = 0; x < w; x++) {
        const u = (x / (w - 1)) * 2 - 1;
        const r2 = u * u + v * v;
        const i = (y * w + x) * 4;
        // Red: sideways, green: up and down; 128 is "stay".
        img.data[i] = Math.round(127.5 + 127.5 * u * r2 / 2);
        img.data[i + 1] = Math.round(127.5 + 127.5 * v * r2 / 2);
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    document.getElementById('mu-glass')?.remove();
    const holder = document.createElement('div');
    holder.innerHTML = `<svg id="mu-glass" width="0" height="0" style="position:absolute" aria-hidden="true">
      <filter id="mu-barrel" x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox" color-interpolation-filters="sRGB">
        <feImage href="${c.toDataURL()}" preserveAspectRatio="none" x="0" y="0" width="1" height="1" result="map"/>
        <feDisplacementMap in="SourceGraphic" in2="map" scale="${BEND}" xChannelSelector="R" yChannelSelector="G"/>
      </filter></svg>`;
    document.body.appendChild(holder.firstElementChild);
  }
  main.classList.add('mu-curve');
}
let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(bendGlass, 200);
}

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
