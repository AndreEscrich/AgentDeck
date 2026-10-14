// The Nostromo theme's tank: one of the ship's screens, picked by what kind
// of task the agent is on (tile.dataset.task, see tasktype.js), drawn in the
// tile's state colour (--c1 in theme-mother.css). How far each screen has got
// is the tile's level (the liquid's height in the other themes).
//
//   boot   MU-TH-UR starting up while it works out what the task is
//   code   a hex dump of a memory bank, rewritten byte by byte
//   art    a wireframe planet, filled in by the scan line
//   track  the motion tracker: contacts close in, fewer as it gets there
//   scan   a star chart: a course plotted from star to star
//   text   MU-TH-UR's terminal typing out the task
//   dock   the approach radar: the ship follows the glide path in
//   map    the terrain scan, mapped line by line (and anything else)
//
// The states look the same on every screen:
//   working, starting: it runs
//   asks you:          it runs slowly
//   stuck:             it stands still and flickers
//   fault:             interference lines cross the screen
//   done, standby:     a still, finished picture (bright until you open it)
//
// A tile that changes screen flips over to the new one like a CRT changing
// channel; finding its task plays the screen's signature once (sounds.js).
// One loop draws every tile's canvas (.tank-scan, made in hub.js),
// about 24 times a second, only while the theme is on and the Hub is on
// screen. Still tiles are drawn again only when something about them changes.

(() => {
  const FPS = 24;
  const N = 14;                 // the terrain's grid lines each way
  const MOVING = new Set(['working', 'starting', 'waiting', 'stuck', 'error']);
  const FLIP = 0.45;            // seconds a channel change takes
  const LABELS = { boot: 'INIT', code: 'CORE', art: 'GEO', track: 'TRACK', scan: 'NAV', text: 'TEXT', dock: 'DOCK', map: 'MAP' };
  const state = new WeakMap();  // canvas -> { seed, level, key, w, h, points, color, colorKey, kind, flipAt, kindAt }

  const rnd = s => { const x = Math.sin(s * 127.1) * 43758.5453; return x - Math.floor(x); };

  // ---------- the terrain (map) ----------

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
    a = Math.max(0, Math.min(1, a));
    if (!m) return `rgba(141, 244, 255, ${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function stateOf(tile) {
    return /state-(\w+)/.exec(tile.className)?.[1] || 'idle';
  }

  // The terrain is drawn in device pixels (its points are); the rest in CSS pixels.
  function terrain(g, x) {
    const { st, s, t, bright, A, dpr } = x;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const P = st.points;
    const rev = st.level * N;
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
      g.strokeStyle = A(a);
      g.setLineDash(on ? [] : [2 * dpr, 4 * dpr]);
      g.beginPath();
      P[j].forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.stroke();
    }
    g.setLineDash([]);
    // Lines along, only over the mapped part.
    const last = Math.min(N, Math.floor(rev));
    if (last > 0) {
      g.strokeStyle = A(bright * 0.55);
      for (let i = 0; i <= N; i++) {
        g.beginPath();
        for (let j = 0; j <= last; j++) (j ? g.lineTo(P[j][i][0], P[j][i][1]) : g.moveTo(P[j][i][0], P[j][i][1]));
        g.stroke();
      }
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- the other screens (CSS pixels; x: see draw) ----------

  // MU-TH-UR wakes: what it reads, and the candidates it weighs.
  function boot(g, x) {
    const { w, h, A, tile, since, live } = x;
    const step = (tile.querySelector('.hub-step')?.textContent || '').toUpperCase().slice(0, 34);
    const lines = ['INTERFACE 2037 READY', '> READING ORDERS', step ? `> ${step}` : '> STANDING BY', '> CLASSIFYING TASK'];
    g.font = '9px monospace';
    const shown = Math.min(lines.length, 1 + Math.floor(since * 1.5));
    lines.slice(0, shown).forEach((l, i) => { g.fillStyle = A(i === shown - 1 ? 0.95 : 0.6); g.fillText(l, 8, 24 + i * 12); });
    const names = Object.values(LABELS).filter(l => l !== 'INIT');
    if (shown === lines.length) { g.fillStyle = A(0.95); g.fillText(`MATCH? ${names[Math.floor(live * 5) % names.length]}`, 8, 24 + 4 * 12); }
    const y = h - 16;
    const segs = 14;
    const bw = (w - 16) / segs;
    const lit = Math.floor((live * 3) % (segs + 1));
    for (let i = 0; i < segs; i++) { g.fillStyle = A(i < lit ? 0.7 : 0.1); g.fillRect(8 + i * bw, y, bw - 2, 6); }
  }

  // A memory bank's hex dump: a write cursor moves along, the bytes it has
  // written stay bright. How much is written is the level.
  function code(g, x) {
    const { w, h, A, st, level, t, moving, bright } = x;
    g.font = '9px monospace';
    const rows = Math.max(3, Math.floor((h - 22) / 11));
    const addrW = 26;
    const cols = Math.max(4, Math.floor((w - addrW - 12) / 15));
    const total = rows * cols;
    const written = Math.floor(total * level);
    const cur = moving ? Math.floor(t * 5) % total : -1;
    for (let r = 0; r < rows; r++) {
      g.fillStyle = A(bright * 0.6);
      g.fillText((0x7f00 + r * 16).toString(16).toUpperCase().slice(-3), 6, 24 + r * 11);
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const changed = i < written && rnd(i * 3 + st.seed) < 0.35;
        const v = Math.floor(rnd(i + st.seed * 7 + (i === cur ? Math.floor(t * 18) : 0)) * 256).toString(16).toUpperCase().padStart(2, '0');
        g.fillStyle = A(i === cur ? 1 : changed ? bright * 1.35 : 0.22);
        g.fillText(v, addrW + 6 + c * 15, 24 + r * 11);
        if (i === cur) { g.strokeStyle = A(0.9); g.strokeRect(addrW + 4 + c * 15, 16 + r * 11, 14, 11); }
      }
    }
  }

  // A wireframe planet turning while the scan line fills it in, top down.
  function art(g, x) {
    const { w, h, A, st, level, t, moving, bright } = x;
    const cx = w / 2;
    // Below the corner label, with room for the scan line at the sides.
    const R = Math.min(w / 2 - 10, (h - 18) / 2 - 2);
    const cy = 14 + (h - 14) / 2;
    const rot = (moving ? t : 1.3) * 0.5 + st.seed;
    g.strokeStyle = A(bright * 0.45);
    for (let i = -3; i <= 3; i++) {
      const yy = cy + R * Math.sin(i * 0.42);
      const rr = R * Math.cos(i * 0.42);
      g.beginPath(); g.ellipse(cx, yy, rr, rr * 0.22, 0, 0, Math.PI * 2); g.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const a = rot + i * Math.PI / 8;
      g.strokeStyle = A((0.1 + 0.3 * Math.abs(Math.sin(a))) * bright * 1.5);
      g.beginPath(); g.ellipse(cx, cy, Math.abs(R * Math.cos(a)), R, 0, 0, Math.PI * 2); g.stroke();
    }
    const top = cy - R;
    const yb = top + 2 * R * level;
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    for (let y = top; y < yb; y += 3) {
      g.strokeStyle = A((0.12 + 0.25 * rnd(Math.floor(y) + Math.floor(rot * 3))) * bright * 1.5);
      g.beginPath(); g.moveTo(cx - R, y); g.lineTo(cx + R, y); g.stroke();
    }
    g.restore();
    if (moving && level < 1) {
      g.strokeStyle = A(0.95);
      g.beginPath(); g.moveTo(cx - R - 6, yb); g.lineTo(cx + R + 6, yb); g.stroke();
    }
  }

  // The motion tracker: a sweep, a ping ring, and contacts closing in.
  // Fewer contacts the further it has got; none when done.
  function track(g, x) {
    const { w, h, A, st, level, t, moving, bright, s } = x;
    const cx = w / 2;
    const cy = h - 6;
    const R = Math.min(h - 14, w / 2 - 6);
    g.strokeStyle = A(bright * 0.5);
    for (let i = 1; i <= 4; i++) { g.beginPath(); g.arc(cx, cy, R * i / 4, Math.PI, 0); g.stroke(); }
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - R); g.stroke();
    if (moving) {
      const sweep = s === 'stuck' ? Math.PI * 1.5 : Math.PI + ((t * 1.2) % 1) * Math.PI;
      g.fillStyle = A(0.14);
      g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, sweep - 0.35, sweep); g.closePath(); g.fill();
      const ring = ((t * 0.8) % 1) * R;
      g.strokeStyle = A(0.5 * (1 - ring / R));
      g.beginPath(); g.arc(cx, cy, ring, Math.PI, 0); g.stroke();
    }
    const contacts = level >= 1 ? 0 : Math.max(1, Math.round((1 - level) * 5));
    for (let i = 0; i < contacts; i++) {
      const a = Math.PI + (0.2 + 0.6 * rnd(i + st.seed)) * Math.PI;
      const d = R * (1 - ((moving ? t * 0.07 : 0.3) + rnd(i + 9 + st.seed)) % 1 * 0.8);
      g.fillStyle = A(0.95);
      g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2.4, 0, Math.PI * 2); g.fill();
    }
  }

  // A star chart: a course plotted from star to star, a leg per stretch of
  // the task; the next leg blinks while it works.
  function scan(g, x) {
    const { w, h, A, st, level, t, moving, bright } = x;
    const pts = [];
    for (let i = 0; i < 18; i++) pts.push([10 + rnd(i + st.seed) * (w - 20), 20 + rnd(i + 40 + st.seed) * (h - 28)]);
    pts.forEach((p, i) => { g.fillStyle = A((0.3 + 0.5 * Math.abs(Math.sin((moving ? t : 0) * 2 + i))) * bright * 1.4); g.fillRect(p[0] - 1, p[1] - 1, 2, 2); });
    const path = [0, 5, 2, 11, 7, 14, 3, 16, 9];
    const k = Math.max(1, Math.round(level * path.length));
    g.strokeStyle = A(bright * 1.2);
    g.setLineDash([3, 3]);
    g.beginPath();
    path.slice(0, k).forEach((i, j) => (j ? g.lineTo(pts[i][0], pts[i][1]) : g.moveTo(pts[i][0], pts[i][1])));
    g.stroke();
    if (moving && k < path.length && Math.floor(t * 3) % 2) {
      const a = pts[path[k - 1]];
      const b = pts[path[k]];
      g.strokeStyle = A(0.4);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    g.setLineDash([]);
    path.slice(0, k).forEach(i => { g.strokeStyle = A(0.9); g.strokeRect(pts[i][0] - 3, pts[i][1] - 3, 6, 6); });
  }

  // MU-TH-UR's terminal types out the task, a line at a time, with the
  // block cursor; how much is typed is the level.
  function text(g, x) {
    const { w, h, A, level, t, moving, bright, tile } = x;
    const words = (tile.querySelector('.hub-title')?.textContent || 'SPECIAL ORDER 937').toUpperCase();
    g.font = '9px monospace';
    const cw = 5.5;
    const per = Math.max(8, Math.floor((w - 16) / cw));
    const lines = [];
    for (const word of words.split(/\s+/)) {
      if (!lines.length || (lines[lines.length - 1] + ' ' + word).length > per) lines.push(word.slice(0, per));
      else lines[lines.length - 1] += ' ' + word;
    }
    const maxLines = Math.max(2, Math.floor((h - 22) / 12));
    const shownLines = lines.slice(0, maxLines);
    const all = shownLines.join('\n');
    const n = Math.max(1, Math.round(all.length * Math.max(level, 0.08)));
    let left = n;
    let lx = 8;
    let ly = 24;
    shownLines.forEach((line, i) => {
      if (left <= 0) return;
      const part = line.slice(0, left);
      g.fillStyle = A(bright * 1.35);
      g.fillText(part, 8, 24 + i * 12);
      lx = 8 + part.length * cw;
      ly = 24 + i * 12;
      left -= line.length + 1;
    });
    if (!moving || Math.floor(t * 2) % 2 === 0) { g.fillStyle = A(0.9); g.fillRect(lx + 1, ly - 8, 5, 10); }
  }

  // The approach radar: range rings, the glide path, and the ship along it
  // as far as the level; docked at the end.
  function dock(g, x) {
    const { w, h, A, level, t, moving, bright, s } = x;
    const sx = w - 18;
    const sy = h / 2 + 6;
    for (let i = 1; i <= 4; i++) {
      g.strokeStyle = A(bright * 0.35);
      g.beginPath(); g.arc(sx, sy, i * (w - 30) / 4, Math.PI * 0.75, Math.PI * 1.25); g.stroke();
    }
    g.strokeStyle = A(bright * 0.6);
    g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(10, sy + 16); g.quadraticCurveTo(w * 0.5, sy + 18, sx, sy); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = A(0.85);
    g.strokeRect(sx - 4, sy - 7, 8, 14);
    const u = Math.min(1, level + (moving && level < 1 ? 0.02 * Math.sin(t * 2) : 0));
    const px = (1 - u) * (1 - u) * 10 + 2 * (1 - u) * u * w * 0.5 + u * u * (sx - 6);
    const py = (1 - u) * (1 - u) * (sy + 16) + 2 * (1 - u) * u * (sy + 18) + u * u * sy + (s === 'stuck' ? 6 : 0);
    g.fillStyle = A(1);
    g.beginPath(); g.moveTo(px + 5, py); g.lineTo(px - 4, py - 4); g.lineTo(px - 4, py + 4); g.closePath(); g.fill();
    if (moving) {
      const ping = (t * 0.7) % 1;
      g.strokeStyle = A(0.5 * (1 - ping));
      g.beginPath(); g.arc(px, py, 3 + ping * 10, 0, Math.PI * 2); g.stroke();
    }
  }

  const SCREENS = { boot, code, art, track, scan, text, dock };

  // What the label in the corner says: the screen's name and its reading.
  function reading(kind, level, s) {
    const pct = `${Math.round(level * 100)}%`;
    const done = level >= 1 && (s === 'idle' || s === 'background');
    switch (kind) {
      case 'boot': return 'INIT';
      case 'code': return `CORE  ${done ? 'WRITTEN' : pct}`;
      case 'art': return `GEO  ${done ? 'MAPPED' : pct}`;
      case 'track': return level >= 1 ? 'TRACK  NO CONTACT' : `TRACK  ${Math.max(1, Math.round((1 - level) * 5))} CONTACTS`;
      case 'scan': return `NAV  ${done ? 'PLOTTED' : pct}`;
      case 'text': return `TEXT  ${done ? 'SENT' : pct}`;
      case 'dock': return level >= 1 ? 'DOCK  DOCKED' : `DOCK  ${Math.round((1 - level) * 1200)}M`;
      default: return `MAP  ${pct}`;
    }
  }

  function draw(canvas, tile, t) {
    let st = state.get(canvas);
    if (!st) {
      st = { seed: Math.random() * 10, level: Math.max(0, Math.min(100, Number(tile.dataset.level) || 0)) / 100, kind: null, flipAt: -9, kindAt: t };
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
    // A new kind of task: flip over to its screen (not the first time it is drawn).
    const kind = tile.dataset.task || 'map';
    if (kind !== st.kind) {
      if (st.kind) {
        st.flipAt = t;
        if (st.kind === 'boot') window.uiSound?.('taskLock', kind);
      }
      st.kind = kind;
      st.kindAt = t;
    }
    const target = Math.max(0, Math.min(100, Number(tile.dataset.level) || 0)) / 100;
    st.level += (target - st.level) * 0.08;
    if (Math.abs(target - st.level) < 0.002) st.level = target;
    const flipping = t - st.flipAt < FLIP;
    const moving = MOVING.has(s) || st.level !== target || flipping;
    const unread = tile.classList.contains('unread');
    const key = `${s}|${unread}|${st.level}|${st.color}|${kind}`;
    if (!moving && key === st.key) return;
    st.key = key;

    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const c = st.color;
    const still = s === 'idle' || s === 'background';
    const bright = still ? (unread ? 0.85 : 0.4) : 0.65;
    // Time runs with the state: slowly while it asks you, not at all while stuck.
    if (s === 'stuck') st.clock = st.clock ?? t;
    else st.clock = null;
    const live = s === 'stuck' ? st.clock : s === 'waiting' ? t * 0.3 : t;
    const x = {
      st, s, t: live, dpr, bright, tile, level: st.level, w: w / dpr, h: h / dpr,
      moving: MOVING.has(s) && s !== 'stuck', since: t - st.kindAt, live,
      A: a => rgba(c, a),
    };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineWidth = 1;
    if (kind === 'map' || !SCREENS[kind]) terrain(g, x);
    else SCREENS[kind](g, x);

    // The screen's name and reading, in the corner.
    if (kind !== 'boot') {
      g.font = '8px monospace';
      g.fillStyle = rgba(c, still && !unread ? 0.45 : 0.7);
      g.fillText(reading(kind, st.level, s), 6, 10);
    }
    // Stuck: the picture flickers.
    if (s === 'stuck' && Math.random() < 0.3) {
      g.fillStyle = rgba(c, 0.12);
      g.fillRect(0, Math.random() * x.h, x.w, 3 + Math.random() * 8);
    }
    // A fault: interference lines across the screen.
    if (s === 'error') {
      g.fillStyle = rgba(c, 0.45);
      for (let k = 0; k < 4; k++) g.fillRect(0, Math.random() * x.h, x.w, 1);
    }
    // Changing channel: the new picture opens from a bright line in the
    // middle, through a moment of static.
    if (flipping) {
      const p = (t - st.flipAt) / FLIP;
      const open = Math.max(0, (p - 0.25) / 0.75);
      const half = (x.h / 2) * open * open;
      g.clearRect(0, 0, x.w, x.h / 2 - half);
      g.clearRect(0, x.h / 2 + half, x.w, x.h / 2 - half + 1);
      g.fillStyle = rgba(c, 0.9 * (1 - open));
      g.fillRect(0, x.h / 2 - 0.75, x.w, 1.5);
      if (p < 0.5) {
        g.fillStyle = rgba(c, 0.35);
        for (let k = 0; k < 30; k++) g.fillRect(Math.random() * x.w, Math.random() * x.h, 1.5, 1.5);
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
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
