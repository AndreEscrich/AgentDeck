// Voice input for the message box (the microphone button, see voice in
// renderer/app.js): a helper listens with the speech recognition the system
// already has, so there is nothing to download.
//   macOS    voice/voice-mac (Apple's Speech framework; the source and how
//            to build it are in voice/voice-mac.swift)
//   Windows  voice/voice-win.ps1 (System.Speech, which comes with Windows)
// The helper writes JSON lines ({ready}, {text, final}, {level}, {error}),
// which go to the window as 'voice:event'. stop() lets it finish the last
// words; cancel() ends it at once.

const { spawn } = require('child_process');
const path = require('path');
const { killTree, isWin } = require('./platform');

let proc = null;

function supported() {
  return process.platform === 'darwin' || isWin;
}

function start(locale, send) {
  cancel();
  if (!supported()) return { ok: false, error: 'Voice input works on macOS and Windows.' };
  const dir = path.join(__dirname, 'voice');
  const p = isWin
    ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'voice-win.ps1'), String(locale || '')], { windowsHide: true })
    : spawn(path.join(dir, 'voice-mac'), [String(locale || '')]);
  proc = p;
  let buffer = '';
  let ended = false;
  const forward = msg => { if (proc === p || msg.final || msg.error) send('voice:event', msg); };
  p.stdout.on('data', d => {
    buffer += d.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.final || msg.error) ended = true;
        forward(msg);
      } catch { /* not ours */ }
    }
  });
  p.stderr.on('data', () => {});
  p.on('error', err => { ended = true; forward({ error: err.message }); });
  p.on('close', code => {
    if (proc === p) proc = null;
    // Ended without a last line: it crashed (for example when macOS stops
    // it), so the window stops listening too.
    if (!ended) send('voice:event', { error: `stopped (${code})` });
  });
  return { ok: true };
}

function stop() {
  if (proc?.stdin.writable) proc.stdin.end('stop\n');
}

function cancel() {
  if (!proc) return;
  const p = proc;
  proc = null;
  killTree(p);
}

module.exports = { supported, start, stop, cancel };
