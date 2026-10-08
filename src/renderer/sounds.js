// Short sounds for agent events, made with Web Audio, so there are no sound
// files. Each note is a sine tone with a soft overtone that fades out like a
// small bell.

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

  return {
    // The new agent's message lands in its tile in the Hub: it starts to brew.
    brew,
    // A new agent: two quick rising notes.
    created: () => play([[659.25, 0, 0.18], [987.77, 0.08, 0.3]], 0.14),
    // An agent finished: a rising major chord, one note after another.
    done: () => play([[523.25, 0, 0.5], [659.25, 0.1, 0.5], [783.99, 0.2, 0.7]]),
    // An agent stopped with an error: two falling notes.
    error: () => play([[440, 0, 0.3], [349.23, 0.14, 0.45]], 0.16),
  };
})();
