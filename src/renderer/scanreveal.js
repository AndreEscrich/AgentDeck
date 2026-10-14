// The Nostromo theme's tank: a terrain scan, like the wireframe ground on
// the ship's screens in Alien. Each tile maps its own piece of terrain line
// by line; how much is mapped is the tile's level (the liquid's height in the
// other themes). The colour is the tile's state colour (--c1 in
// theme-mother.css), so a finished agent's map is green.
//
//   working, starting: a bright scan line sweeps at the edge of the map
//   asks you:          the scan line pulses slowly at the edge
//   stuck:             the scan line stands still and flickers
//   fault:             interference lines cross the screen
//   done, standby:     a still map (bright until you open the agent)
//
// One loop draws every tile's canvas (.tank-scan, made in hub.js), about 24
// times a second, only while the theme is on and the Hub is on screen. Still
// tiles are drawn again only when something about them changes.

(() => {
  const FPS = 24;
  const N = 14;                 // grid lines each way
  const MOVING = new Set(['working', 'starting', 'waiting', 'stuck', 'error']);
  const state = new WeakMap();  // canvas -> { seed, level, key, w, h, points, color, colorKey }

  // The ground's height at a grid point, different for every tile (seed).
  const height = (i, j, s) => Math.max(0,
    Math.sin(i * 0.36 + s * 1.7 + j * 0.12) * Math.cos(j * 0.28 - i * 0.08 + s)
    + 0.4 * Math.sin(i * 0.84 + j * 0.68 + s * 2.3));

  // The grid seen from above at an angle, scaled to fit the canvas.
  function project(st) {
    const a = 0.6;
    const raw = [];
    for (let j = 0; j <= N; j++) {
      const row = [];
      for (let i = 0; i <= N; i++) {
        const x = i - N / 2;
        const z = (j - N / 2) * 0.9;
        const y = height(i, j, st.seed) * 1.2;
        row.push([x * Math.cos(a) - z * Math.sin(a), (x * Math.sin(a) + z * Math.cos(a)) * 0.62 - y]);
      }
      raw.push(row);
    }
    const xs = raw.flat().map(p => p[0]);
    const ys = raw.flat().map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 0.05;
    const scale = Math.min(st.w * (1 - 2 * pad) / (x1 - x0), st.h * (1 - 2 * pad) / (y1 - y0));
    const ox = (st.w - (x1 - x0) * scale) / 2 - x0 * scale;
    const oy = (st.h - (y1 - y0) * scale) / 2 - y0 * scale;
    st.points = raw.map(row => row.map(([x, y]) => [ox + x * scale, oy + y * scale]));
  }

  function rgba(color, a) {
    const m = /#([0-9a-f]{6})/i.exec(color);
    if (!m) return `rgba(141, 244, 255, ${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function stateOf(tile) {
    const s = /state-(\w+)/.exec(tile.className)?.[1] || 'idle';
    return s;
  }

  function draw(canvas, tile, t) {
    let st = state.get(canvas);
    if (!st) {
      st = { seed: Math.random() * 10, level: Number(tile.dataset.level) || 0 };
      state.set(canvas, st);
    }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (w !== st.w || h !== st.h) {
      canvas.width = w;
      canvas.height = h;
      st.w = w;
      st.h = h;
      project(st);
      st.key = null;
    }
    const s = stateOf(tile);
    // The colour follows the tile's state classes; read it again only when they change.
    if (st.colorKey !== tile.className) {
      st.colorKey = tile.className;
      st.color = getComputedStyle(tile).getPropertyValue('--c1').trim();
    }
    const target = Math.max(0, Math.min(100, Number(tile.dataset.level) || 0)) / 100;
    st.level += (target - st.level) * 0.08;
    if (Math.abs(target - st.level) < 0.002) st.level = target;
    const moving = MOVING.has(s) || st.level !== target;
    const unread = tile.classList.contains('unread');
    const key = `${s}|${unread}|${st.level}|${st.color}`;
    if (!moving && key === st.key) return;
    st.key = key;

    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    const c = st.color;
    const P = st.points;
    const rev = st.level * N;
    const still = s === 'idle' || s === 'background';
    const bright = still ? (unread ? 0.85 : 0.4) : 0.65;
    // Where the scan line is: at the edge of the map, moving with the state.
    const sweep = s === 'working' || s === 'starting' ? rev - ((t * 2) % 2)
      : s === 'waiting' ? rev - 0.5 + Math.sin(t * 2) * 0.5
      : s === 'stuck' ? rev - 0.5
      : -9;
    g.lineWidth = Math.max(1, dpr * 0.9);
    // Lines across: mapped ones solid, the rest faint dots.
    for (let j = 0; j <= N; j++) {
      const on = j <= rev;
      let a = on ? bright : 0.1;
      if (on && Math.abs(j - sweep) < 0.8) a = s === 'stuck' && Math.floor(t * 8) % 2 ? 0.3 : 1;
      g.strokeStyle = rgba(c, a);
      g.setLineDash(on ? [] : [2 * dpr, 4 * dpr]);
      g.beginPath();
      P[j].forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.stroke();
    }
    g.setLineDash([]);
    // Lines along, only over the mapped part.
    const last = Math.min(N, Math.floor(rev));
    if (last > 0) {
      g.strokeStyle = rgba(c, bright * 0.55);
      for (let i = 0; i <= N; i++) {
        g.beginPath();
        for (let j = 0; j <= last; j++) (j ? g.lineTo(P[j][i][0], P[j][i][1]) : g.moveTo(P[j][i][0], P[j][i][1]));
        g.stroke();
      }
    }
    // A fault: interference lines across the screen.
    if (s === 'error') {
      g.fillStyle = rgba(c, 0.45);
      for (let k = 0; k < 4; k++) g.fillRect(0, Math.random() * h, w, dpr);
    }
  }

  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.documentElement.dataset.theme !== 'mother' || document.hidden) return;
    if (now - last < 1000 / FPS) return;
    last = now;
    const t = now / 1000;
    for (const canvas of document.querySelectorAll('.hub-tile .tank-scan')) {
      if (!canvas.getClientRects().length) continue;   // not on screen (another view, a hidden group)
      draw(canvas, canvas.closest('.hub-tile'), t);
    }
  }
  requestAnimationFrame(frame);
})();
