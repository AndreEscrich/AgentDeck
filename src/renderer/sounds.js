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

  return {
    // A new agent: two quick rising notes.
    created: () => play([[659.25, 0, 0.18], [987.77, 0.08, 0.3]], 0.14),
    // An agent finished: a rising major chord, one note after another.
    done: () => play([[523.25, 0, 0.5], [659.25, 0.1, 0.5], [783.99, 0.2, 0.7]]),
    // An agent stopped with an error: two falling notes.
    error: () => play([[440, 0, 0.3], [349.23, 0.14, 0.45]], 0.16),
  };
})();
