// Shell commands an agent asks you to run (a ```bash block in its answer):
// the Run button under the block runs it here, in the agent's folder, and
// streams its output back to the window ('command:output'), like the Run
// button in Claude's desktop app.
//
// The command gets no input: a command that asks for a password or opens an
// editor fails at once instead of waiting forever for an answer.

const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { isWin, killTree, childEnv } = require('./platform');

const running = new Map();

function shellFor(command) {
  if (isWin) return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', command] };
  return { file: process.env.SHELL || '/bin/zsh', args: ['-c', command] };
}

// Resolves with { code } when the command ends (code is null when it was
// stopped, -1 when it could not start).
function run(config, id, cwd, command, send) {
  stop(id);
  return new Promise(resolve => {
    const { file, args } = shellFor(String(command));
    const dir = typeof cwd === 'string' && fs.existsSync(cwd) ? cwd : os.homedir();
    let p;
    try {
      p = spawn(file, args, {
        cwd: dir,
        env: childEnv({ ...config.env, TERM: 'dumb', NO_COLOR: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWin,
        windowsHide: true,
      });
    } catch (err) {
      send('command:output', id, err.message + '\n');
      resolve({ code: -1 });
      return;
    }
    running.set(id, p);
    let stopped = false;
    p.stopped = () => { stopped = true; };
    const onData = d => send('command:output', id, d.toString('utf8'));
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const done = code => {
      if (running.get(id) === p) running.delete(id);
      resolve({ code: stopped ? null : code });
    };
    p.on('error', err => { send('command:output', id, err.message + '\n'); done(-1); });
    p.on('close', done);
  });
}

function stop(id) {
  const p = running.get(id);
  if (!p) return;
  p.stopped();
  killTree(p);
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

module.exports = { run, stop, stopAll };
