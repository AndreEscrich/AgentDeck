// The app's look (Settings → Theme). "default" is the app's own look;
// "mother" is the retro terminal of Alien (theme-mother.css), which also
// gets the moving parts of an old tube here: static, a rolling band, now and
// then a sync glitch, and a power-on when the theme starts.
//
// The choice lives in config.json; a copy in localStorage lets the window
// open in the right look before the config arrives.

const THEMES = [['default', 'Default'], ['mother', 'MU-TH-UR · retro terminal']];
const crt = { glitch: 0 };

function applyTheme(name, { powerOn = true } = {}) {
  const theme = THEMES.some(([v]) => v === name) ? name : 'default';
  const was = document.documentElement.dataset.theme || 'default';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch { /* the theme still applies */ }
  document.getElementById('theme-mother').disabled = theme !== 'mother';
  if (theme === 'mother') startTube({ powerOn: powerOn && was !== 'mother' });
  else stopTube();
}

function startTube({ powerOn }) {
  for (const id of ['mu-roll', 'mu-noise']) {
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
  for (const id of ['mu-roll', 'mu-noise']) document.getElementById(id)?.remove();
  document.getElementById('main')?.classList.remove('mu-glitch', 'mu-on');
}

function replayClass(node, name, ms) {
  node.classList.remove(name);
  void node.offsetWidth;
  node.classList.add(name);
  setTimeout(() => node.classList.remove(name), ms);
}

// Before anything is drawn: the look you had last time.
try { applyTheme(localStorage.getItem('theme') || 'default'); } catch { applyTheme('default'); }
