// Short sounds for agent events, made with Web Audio, so there are no sound
// files. Two styles (Settings > The app > Sounds): "classic", sine tones
// with a soft overtone that fade out like small bells, and "jrpg", the
// square-wave blips and jingles of a retro role-playing game's menus.

const classicSounds = (() => {
  let ctx = null;

  function audio() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // One note: frequency in Hz, start offset and length in seconds.
  function note(ac, out, freq, at, length, volume) {
    const t = ac.currentTime + at;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    gain.connect(out);
    for (const [mult, level] of [[1, 1], [2, 0.18]]) {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      g.gain.value = level;
      osc.connect(g).connect(gain);
      osc.start(t);
      osc.stop(t + length + 0.05);
    }
  }

  function play(notes, volume = 0.18) {
    try {
      const ac = audio();
      const out = ac.createGain();
      out.gain.value = 1;
      out.connect(ac.destination);
      for (const [freq, at, length] of notes) note(ac, out, freq, at, length, volume);
    } catch { /* no sound is fine */ }
  }

  // One bubble: a short tone that slides up as it pops.
  function bubble(ac, out, at, freq, volume) {
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.9, t + 0.07);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  // A soft hiss under the bubbles, like liquid starting to simmer.
  function simmer(ac, out, length, volume) {
    const t = ac.currentTime;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * length), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.8;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    noise.connect(filter).connect(gain).connect(out);
    noise.start(t);
  }

  function brew() {
    try {
      const ac = audio();
      const out = ac.createGain();
      out.connect(ac.destination);
      simmer(ac, out, 1.1, 0.035);
      // Bubbles come quickly at first, then fewer and quieter.
      let at = 0.02;
      for (let i = 0; i < 11; i++) {
        bubble(ac, out, at, 380 + Math.random() * 700, 0.12 * (1 - i / 14));
        at += 0.04 + Math.random() * 0.05 + i * 0.008;
      }
    } catch { /* no sound is fine */ }
  }

  // A tone that slides down while it fades, with a breath of noise: a tile
  // dropping out of the Hub.
  function swoosh() {
    try {
      const ac = audio();
      const t = ac.currentTime;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(620, t);
      osc.frequency.exponentialRampToValueAtTime(140, t + 0.4);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.015);
      gain.gain.setValueAtTime(0.16, t + 0.14);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.46);
      simmer(ac, ac.destination, 0.25, 0.025);
    } catch { /* no sound is fine */ }
  }

  // A tone that slides from one pitch to another while it fades.
  function slide(ac, at, from, to, length, volume) {
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + length * 0.88);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + length + 0.04);
  }

  // A whole group: one short swoosh per tile, each a little lower (timed
  // with the tiles dropping out), then a soft low thud as the panel folds.
  function groupRemoved(count) {
    try {
      const ac = audio();
      const n = Math.min(Math.max(count, 1), 8);
      for (let i = 0; i < n; i++) slide(ac, i * 0.09, 700 - i * 45, 180 - i * 8, 0.26, 0.12);
      const end = (n - 1) * 0.09 + 0.6;
      slide(ac, end, 190, 55, 0.35, 0.22);
      simmer(ac, ac.destination, end + 0.3, 0.02);
    } catch { /* no sound is fine */ }
  }

  // A short airy sweep: up when something opens, down when it closes.
  function sweep(from, to, volume) {
    try {
      const ac = audio();
      slide(ac, 0, from, to, 0.2, volume);
      simmer(ac, ac.destination, 0.16, 0.012);
    } catch { /* no sound is fine */ }
  }

  // One bubble popping, for small things that land somewhere.
  function pop(freq, volume) {
    try {
      const ac = audio();
      bubble(ac, ac.destination, 0, freq, volume);
    } catch { /* no sound is fine */ }
  }

  return {
    // Creating the audio engine takes about 180 ms, once. The app does that
    // while you are idle after it starts, not on the first sound (which is
    // when you press Enter to create an agent).
    warm: () => { try { audio(); } catch { /* no audio */ } },
    // The new agent's message lands in its tile in the Hub: it starts to brew.
    brew,
    // An agent asks you a question or needs your approval: two bell taps.
    attention: () => play([[880, 0, 0.4], [880, 0.17, 0.6]], 0.2),
    // An agent is removed from the Hub.
    removed: swoosh,
    // Dragging a tile: a soft pop when you pick it up, a tiny tick each
    // time the others make room, and a low thud when it lands.
    pick: () => { try { slide(audio(), 0, 320, 560, 0.1, 0.1); } catch { /* no sound is fine */ } },
    shift: () => play([[1320, 0, 0.05]], 0.035),
    drop: () => { try { const ac = audio(); slide(ac, 0, 240, 85, 0.2, 0.2); slide(ac, 0.07, 180, 120, 0.1, 0.06); } catch { /* no sound is fine */ } },
    // Tab opens the next agent to check: a quick airy flick upwards.
    tab: () => {
      try {
        const ac = audio();
        slide(ac, 0, 430, 900, 0.16, 0.11);
        simmer(ac, ac.destination, 0.12, 0.015);
      } catch { /* no sound is fine */ }
    },
    // Tab with nothing to check: two soft low notes.
    nothing: () => play([[392, 0, 0.15], [329.63, 0.09, 0.28]], 0.1),
    // A whole group is removed from the Hub; count is its number of agents.
    groupRemoved,
    // A new agent: two quick rising notes.
    created: () => play([[659.25, 0, 0.18], [987.77, 0.08, 0.3]], 0.14),
    // An agent finished: a rising major chord, one note after another.
    done: () => play([[523.25, 0, 0.5], [659.25, 0.1, 0.5], [783.99, 0.2, 0.7]]),
    // An agent stopped with an error: two falling notes.
    error: () => play([[440, 0, 0.3], [349.23, 0.14, 0.45]], 0.16),

    // You sent a message to an agent: a bubble pops, then a short bright
    // note confirms it, while the chat shrinks back into the tile.
    sent: () => {
      try {
        const ac = audio();
        bubble(ac, ac.destination, 0, 520, 0.16);
        slide(ac, 0.05, 700, 1180, 0.16, 0.08);
      } catch { /* no sound is fine */ }
    },
    // Opening an agent's chat from its tile, or a saved session: up.
    open: () => sweep(300, 640, 0.07),
    // Back to the Hub (the chat shrinks into its tile): down.
    close: () => sweep(560, 260, 0.06),
    // You stopped an agent's task: a short low knock.
    stopped: () => { try { const ac = audio(); slide(ac, 0, 330, 140, 0.18, 0.16); slide(ac, 0.06, 160, 110, 0.12, 0.06); } catch { /* no sound is fine */ } },
    // An agent looks stuck: two slow, low notes, a little out of tune.
    stuck: () => play([[311.13, 0, 0.45], [293.66, 0.22, 0.6]], 0.11),
    // You allowed a tool, or answered a question: two quick rising notes.
    approve: () => play([[783.99, 0, 0.12], [1046.5, 0.06, 0.22]], 0.11),
    // You denied a tool, or skipped a question: two quick falling notes.
    deny: () => play([[392, 0, 0.12], [311.13, 0.07, 0.25]], 0.1),
    // An image or video lands in the message box; one is taken out.
    attach: () => pop(620, 0.16),
    detach: () => { try { slide(audio(), 0, 760, 420, 0.09, 0.06); } catch { /* no sound is fine */ } },
    // Small clicks: a menu, a card or a dialog opens (tick) or closes
    // (tickDown), an option or a filter is picked (select).
    tick: () => play([[1568, 0, 0.05]], 0.04),
    tickDown: () => play([[1174.66, 0, 0.05]], 0.035),
    select: () => play([[1318.51, 0, 0.06]], 0.05),
    // A connector finished signing in: the "done" chord, softer.
    connected: () => play([[659.25, 0, 0.35], [987.77, 0.09, 0.5]], 0.12),
    // Something that cannot be done (a file type the box does not take).
    refuse: () => play([[233.08, 0, 0.12], [233.08, 0.1, 0.16]], 0.08),
  };
})();

// Retro RPG menu sounds: square and triangle waves through a soft low-pass,
// with a short echo. Moving around is a tiny blip, confirming goes up,
// cancelling goes down; agent events get small jingles.
const jrpgSounds = (() => {
  let ctx = null;
  let master = null;
  let echo = null;

  function audio() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
      // The echo: a short delay that feeds back a little, mixed in quietly.
      echo = ctx.createDelay();
      echo.delayTime.value = 0.11;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.22;
      const wet = ctx.createGain();
      wet.gain.value = 0.25;
      echo.connect(feedback).connect(echo);
      echo.connect(wet).connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // One note: frequency, start offset and length in seconds. slide: the pitch
  // at the end as a factor; vib: vibrato depth as a share of the pitch.
  function note(freq, at, length, { type = 'square', volume = 0.13, slide = 0, vib = 0 } = {}) {
    try {
      const ac = audio();
      const t = ac.currentTime + at;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const lowpass = ac.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = type === 'square' ? 3200 : 6000;
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + length);
      if (vib) {
        const lfo = ac.createOscillator();
        const depth = ac.createGain();
        lfo.frequency.value = 6;
        depth.gain.value = freq * vib;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(t);
        lfo.stop(t + length + 0.05);
      }
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + length);
      osc.connect(lowpass).connect(gain);
      gain.connect(master);
      gain.connect(echo);
      osc.start(t);
      osc.stop(t + length + 0.02);
    } catch { /* no sound is fine */ }
  }

  // A breath of filtered noise sweeping from one pitch to another.
  function whoosh(at, length, from, to, volume = 0.1) {
    try {
      const ac = audio();
      const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * length), ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = ac.createBufferSource();
      source.buffer = buffer;
      const band = ac.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 4;
      const t = ac.currentTime + at;
      band.frequency.setValueAtTime(from, t);
      band.frequency.exponentialRampToValueAtTime(to, t + length);
      const gain = ac.createGain();
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + length);
      source.connect(band).connect(gain).connect(master);
      source.start(t);
    } catch { /* no sound is fine */ }
  }

  const cursor = (pitch = 1568, volume = 0.12) => { note(pitch, 0, 0.045, { volume }); note(pitch * 4 / 3, 0.018, 0.04, { volume: volume * 0.6 }); };
  const confirm = () => { note(1318.5, 0, 0.06); note(1975.5, 0.055, 0.12); };
  const cancel = (volume = 0.14) => { note(1046.5, 0, 0.06, { volume }); note(698.5, 0.05, 0.1, { volume: volume * 0.85 }); };
  const buzz = () => { note(110, 0, 0.16, { volume: 0.2 }); note(116.5, 0, 0.16, { volume: 0.14 }); };
  const flee = () => { whoosh(0, 0.25, 2500, 300, 0.09); note(880, 0, 0.25, { volume: 0.08, slide: 0.35 }); };
  const savePoint = () => {
    [1046.5, 1568, 2093].forEach((f, i) => note(f, i * 0.08, 0.5, { type: 'sine', volume: 0.08 }));
    note(2637, 0.24, 0.7, { type: 'sine', volume: 0.05, vib: 0.004 });
  };

  // An agent finished: "ta-daa", two quick notes and a held chord. When
  // several finish close together, the later ones get a short soft chime.
  let lastDone = 0;
  function done() {
    const now = Date.now();
    const crowded = now - lastDone < 4000;
    lastDone = now;
    if (crowded) {
      [1046.5, 1318.5, 1568].forEach((f, i) => note(f, i * 0.03, 0.6, { type: 'triangle', volume: 0.08 }));
      note(2093, 0.09, 0.5, { type: 'sine', volume: 0.05 });
      return;
    }
    note(784, 0, 0.07);
    note(784, 0.08, 0.07);
    note(1046.5, 0.18, 0.5, { vib: 0.012 });
    note(659.3, 0.18, 0.5, { type: 'triangle', volume: 0.07 });
    note(523.3, 0.18, 0.5, { type: 'triangle', volume: 0.06 });
  }

  return {
    warm: () => { try { audio(); } catch { /* no audio */ } },
    // The new agent's message lands in its tile: a summoning arpeggio.
    brew: () => {
      [392, 523.3, 659.3, 784, 1046.5, 1318.5].forEach((f, i) => note(f, i * 0.05, 0.22, { type: 'triangle', volume: 0.1 }));
      whoosh(0.05, 0.35, 1500, 7000, 0.04);
      note(2637, 0.32, 0.4, { type: 'sine', volume: 0.05 });
    },
    // An agent asks you something: an alert, two taps and a ring.
    attention: () => { note(1760, 0, 0.09); note(1760, 0.13, 0.09); note(2349, 0.26, 0.25, { type: 'triangle', volume: 0.1 }); },
    removed: flee,
    pick: () => cursor(1318.5),
    shift: () => note(2093, 0, 0.03, { volume: 0.05 }),
    drop: () => { note(196, 0, 0.09, { volume: 0.16, slide: 0.7 }); note(1046.5, 0.03, 0.05, { volume: 0.06 }); },
    tab: () => cursor(1760),
    nothing: buzz,
    groupRemoved: count => {
      const n = Math.min(Math.max(count, 1), 8);
      for (let i = 0; i < n; i++) note(1318.5 - i * 90, i * 0.07, 0.08, { volume: 0.09 });
      whoosh(n * 0.07, 0.3, 2200, 250, 0.08);
    },
    created: confirm,
    done,
    // An agent stopped with an error: knocked out, three falling notes.
    error: () => { note(392, 0, 0.2, { volume: 0.14, slide: 0.8 }); note(311.1, 0.18, 0.22, { volume: 0.14, slide: 0.8 }); note(233.1, 0.38, 0.5, { volume: 0.15, slide: 0.6 }); },
    sent: confirm,
    open: () => { whoosh(0, 0.14, 600, 3200, 0.07); note(880, 0.05, 0.07, { volume: 0.07 }); },
    close: () => cancel(0.1),
    stopped: flee,
    // An agent looks stuck: a woozy status effect.
    stuck: () => { for (let i = 0; i < 3; i++) note(196, i * 0.16, 0.14, { type: 'triangle', volume: 0.1, vib: 0.06 }); note(185, 0.48, 0.35, { type: 'triangle', volume: 0.1, vib: 0.08 }); },
    approve: () => { note(1568, 0, 0.06); note(2349, 0.055, 0.12); },
    deny: () => cancel(),
    // A file lands in the message box: "item get".
    attach: () => [1046.5, 1318.5, 1568, 2093].forEach((f, i) => note(f, i * 0.045, 0.09, { type: 'triangle', volume: 0.1 })),
    detach: () => cancel(0.08),
    tick: () => cursor(1568, 0.08),
    tickDown: () => cursor(1318.5, 0.07),
    select: () => cursor(1760, 0.08),
    connected: savePoint,
    refuse: buzz,
  };
})();

// The style in use: Settings > The app > Sounds ("jrpg" unless set to "classic").
const sounds = new Proxy({}, {
  get(_target, name) {
    const style = typeof state !== 'undefined' && state.config?.soundTheme === 'classic' ? classicSounds : jrpgSounds;
    return style[name] || classicSounds[name];
  },
});
