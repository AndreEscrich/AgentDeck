// Short sounds for agent events, made with Web Audio, so there are no sound
// files. Each note is a sine tone with a soft overtone that fades out like a
// small bell. The retro theme has its own set (mother, below).

const sounds = (() => {
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

  const plain = {
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

  // ---------- MU-TH-UR (the retro theme) ----------
  // The same events, in the voice of the ship's computer in Alien: cold and
  // uneasy rather than cheerful. Low tones, intervals that do not resolve
  // (tritones, minor seconds), pairs of oscillators a little out of tune so
  // they beat slowly, low drones and breaths of noise, all sounding in a
  // long metal corridor (a reverb made of decaying noise).

  // Everything goes through one bus: dry, plus the corridor's echo.
  let bus = null;
  function out(ac) {
    if (bus) return bus;
    bus = ac.createGain();
    bus.gain.value = 1;
    bus.connect(ac.destination);
    const length = Math.ceil(ac.sampleRate * 2.8);
    const impulse = ac.createBuffer(2, length, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
    }
    const verb = ac.createConvolver();
    verb.buffer = impulse;
    // The echo is dark: the highs die first in a steel hull.
    const tone = ac.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2200;
    const wet = ac.createGain();
    wet.gain.value = 0.45;
    bus.connect(verb).connect(tone).connect(wet).connect(ac.destination);
    return bus;
  }

  // One tone: two oscillators a few cents apart, so it wavers.
  function tone(ac, at, freq, length, volume, { type = 'triangle', detune = 7, attack = 0.004, cutoff = 2400, slideTo = null } = {}) {
    const t = ac.currentTime + at;
    const filter = ac.createBiquadFilter();
    const gain = ac.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.setValueAtTime(volume, t + Math.max(attack, length * 0.45));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    filter.connect(gain).connect(out(ac));
    for (const cents of [-detune, detune]) {
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + length);
      osc.detune.value = cents;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + length + 0.05);
    }
  }

  // Data: a run of short low blips from a cluster of tones that clash.
  const DATA_TONES = [311, 330, 466, 494, 622, 659, 932];
  function data(ac, at, count, { step = 0.06, volume = 0.05, direction = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      let k = Math.floor(Math.random() * DATA_TONES.length);
      if (direction) {
        const pos = direction > 0 ? i / count : 1 - i / count;
        k = Math.min(DATA_TONES.length - 1, Math.max(0, Math.round(pos * (DATA_TONES.length - 1) + (Math.random() * 2 - 1))));
      }
      tone(ac, at + i * step, DATA_TONES[k], step * 0.9, volume, { type: 'square', detune: 4, cutoff: 1500 });
    }
    return at + count * step;
  }

  // A breath of filtered noise: air in the vents, a relay, a key.
  function breath(ac, at, freq, length, volume, { q = 1.2, swell = false } = {}) {
    const t = ac.currentTime + at;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * length), ac.sampleRate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(swell ? 0 : volume, t);
    if (swell) gain.gain.linearRampToValueAtTime(volume, t + length * 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(filter).connect(gain).connect(out(ac));
    src.start(t);
  }

  // A low drone that swells and fades: the ship's engines, a warning.
  function drone(ac, at, freq, length, volume, type = 'sawtooth') {
    tone(ac, at, freq, length, volume, { type, detune: 12, attack: length * 0.3, cutoff: 500 });
  }

  const safely = fn => (...args) => { try { fn(audio(), ...args); } catch { /* no sound is fine */ } };

  const mother = {
    // A new agent lands in its tile: the computer wakes, a slow run of data
    // over a low drone.
    brew: safely(ac => { drone(ac, 0, 55, 1.4, 0.07); data(ac, 0.1, 9, { step: 0.07 }); }),
    // An agent needs you: two slow low pulses a tritone apart, like a
    // warning on the bridge.
    attention: safely(ac => {
      for (const at of [0, 0.55]) {
        tone(ac, at, 311, 0.4, 0.06, { type: 'square', cutoff: 1100 });
        tone(ac, at, 440, 0.4, 0.045, { type: 'square', cutoff: 1100 });
      }
    }),
    removed: safely(ac => { const end = data(ac, 0, 6, { direction: -1, step: 0.05 }); drone(ac, end - 0.1, 41, 0.6, 0.12, 'square'); }),
    pick: safely(ac => tone(ac, 0, 233, 0.12, 0.06)),
    shift: safely(ac => tone(ac, 0, 622, 0.04, 0.02)),
    drop: safely(ac => { tone(ac, 0, 98, 0.25, 0.1, { slideTo: 73 }); breath(ac, 0, 500, 0.08, 0.2); }),
    tab: safely(ac => { tone(ac, 0, 330, 0.09, 0.05); tone(ac, 0.09, 311, 0.14, 0.05); }),
    nothing: safely(ac => tone(ac, 0, 82, 0.35, 0.09, { type: 'square', cutoff: 600 })),
    groupRemoved: safely((ac, count) => {
      const end = data(ac, 0, Math.min(4 + count * 2, 18), { direction: -1, step: 0.05 });
      drone(ac, end - 0.1, 36, 1.0, 0.14, 'square');
    }),
    created: safely(ac => { data(ac, 0, 5, { direction: 1, step: 0.07 }); breath(ac, 0, 700, 0.6, 0.05, { swell: true }); }),
    // Finished: the computer prints its answer, then a falling minor second,
    // as if it knows more than it says.
    done: safely(ac => {
      const end = data(ac, 0, 7, { step: 0.06 });
      tone(ac, end + 0.08, 494, 0.5, 0.06);
      tone(ac, end + 0.4, 466, 0.9, 0.06);
    }),
    // A fault: a low growl with a falling tritone in it.
    error: safely(ac => {
      drone(ac, 0, 49, 1.0, 0.13);
      tone(ac, 0.05, 370, 0.35, 0.06, { type: 'square', cutoff: 1000 });
      tone(ac, 0.35, 262, 0.7, 0.06, { type: 'square', cutoff: 900 });
    }),
    // Your message goes out: a short burst of data and a hiss, like a
    // transmission into the dark.
    sent: safely(ac => { data(ac, 0, 8, { step: 0.035, volume: 0.04 }); breath(ac, 0.05, 1800, 0.45, 0.06, { q: 0.7 }); }),
    // A screen comes up: a relay, a low hum and the tube's thin whine.
    open: safely(ac => { breath(ac, 0, 900, 0.05, 0.25); drone(ac, 0, 60, 0.5, 0.06, 'sine'); tone(ac, 0.02, 1400, 0.4, 0.008, { type: 'sine', slideTo: 3200 }); }),
    close: safely(ac => { tone(ac, 0, 330, 0.2, 0.04, { slideTo: 196 }); breath(ac, 0.12, 500, 0.06, 0.2); }),
    stopped: safely(ac => { tone(ac, 0, 147, 0.3, 0.09, { type: 'square', cutoff: 700, slideTo: 104 }); breath(ac, 0, 400, 0.06, 0.3); }),
    // Stuck: a slow pulse that does not change, like a heartbeat monitor.
    stuck: safely(ac => { for (let i = 0; i < 3; i++) tone(ac, i * 0.5, 104, 0.3, 0.07, { type: 'sine', cutoff: 600 }); }),
    approve: safely(ac => { tone(ac, 0, 330, 0.12, 0.05); tone(ac, 0.09, 494, 0.25, 0.05); }),
    deny: safely(ac => { tone(ac, 0, 330, 0.12, 0.05); tone(ac, 0.1, 233, 0.35, 0.05); }),
    attach: safely(ac => tone(ac, 0, 466, 0.15, 0.045)),
    detach: safely(ac => tone(ac, 0, 311, 0.15, 0.04)),
    tick: safely(ac => tone(ac, 0, 659, 0.05, 0.025, { type: 'square', cutoff: 1400 })),
    tickDown: safely(ac => tone(ac, 0, 622, 0.05, 0.022, { type: 'square', cutoff: 1400 })),
    select: safely(ac => tone(ac, 0, 494, 0.06, 0.03, { type: 'square', cutoff: 1400 })),
    connected: safely(ac => { const end = data(ac, 0, 5); tone(ac, end + 0.05, 494, 0.6, 0.05); }),
    refuse: safely(ac => tone(ac, 0, 69, 0.4, 0.1, { type: 'square', cutoff: 500 })),
    // Typing: each letter that comes up on MOTHER's screen has its blip,
    // here low and muted, over the dull click of the key.
    // kind: 'char', 'space', 'back' or 'enter'.
    key: safely((ac, kind = 'char') => {
      if (kind === 'back') { tone(ac, 0, 233, 0.06, 0.03, { type: 'square', cutoff: 900, detune: 3 }); breath(ac, 0, 1200, 0.015, 0.1); return; }
      if (kind === 'enter') { tone(ac, 0, 330, 0.08, 0.035, { type: 'square', cutoff: 1100 }); tone(ac, 0.08, 311, 0.14, 0.035, { type: 'square', cutoff: 1100 }); breath(ac, 0, 900, 0.03, 0.15); return; }
      const tones = kind === 'space' ? [392] : [622, 659, 698, 740];
      tone(ac, 0, tones[Math.floor(Math.random() * tones.length)], 0.045, 0.028, { type: 'square', cutoff: 1300, detune: 3 });
      breath(ac, 0, 1800, 0.012, 0.09);
    }),
    // The theme switches on: the tube's thunk, the ship's hum swelling, the
    // high voltage whining up, then the computer stirs.
    powerOn: safely(ac => {
      breath(ac, 0, 200, 0.12, 0.5);
      drone(ac, 0.02, 41, 2.2, 0.12);
      drone(ac, 0.3, 61.7, 1.9, 0.05);
      tone(ac, 0.1, 2000, 1.6, 0.007, { type: 'sine', slideTo: 7500, attack: 0.8 });
      const end = data(ac, 0.9, 6, { step: 0.08 });
      tone(ac, end + 0.1, 466, 1.0, 0.05);
    }),
  };

  // Each sound in the voice of the theme you picked (Settings → Theme).
  const voice = () => (document.documentElement.dataset.theme === 'mother' ? mother : plain);
  const api = { warm: plain.warm };
  for (const name of new Set([...Object.keys(plain), ...Object.keys(mother)])) {
    if (name === 'warm') continue;
    api[name] = (...args) => (voice()[name] || plain[name])?.(...args);
  }
  return api;
})();
