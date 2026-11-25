const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { childEnv } = require('./platform');
const { focus } = require('./unityapp');

const isProject = d => fs.existsSync(path.join(d, 'project.gameengine.json'));

function gameEngineRoot(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  if (isProject(dir)) return dir;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && isProject(path.join(dir, e.name))) return path.join(dir, e.name);
    }
  } catch {}
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
    if (isProject(dir)) return dir;
  }
  return null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function editorPid(root) {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(path.join(root, '.gameengine', 'editor.json'), 'utf8'))?.pid);
    return pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function status(cwd) {
  const root = gameEngineRoot(cwd);
  if (!root) return { gameEngine: false };
  const pid = editorPid(root);
  return { gameEngine: true, editor: 'Game Engine', root, running: !!pid, pid };
}

async function open(cwd) {
  const s = await status(cwd);
  if (!s.gameEngine) return { ok: false, message: 'This folder is not a Game Engine project.' };
  if (s.running) {
    await focus(s.pid);
    return { ok: true, action: 'focused' };
  }
  return new Promise(resolve => {
    execFile('gameengine', ['editor', '--project', s.root], { cwd: s.root, env: childEnv(), timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, errOut) => {
      if (!err) return resolve({ ok: true, action: 'opened' });
      if (err.code === 'ENOENT') return resolve({ ok: false, message: 'The gameengine command is not installed. Run the Game Engine\'s setup, or open the editor with `gameengine editor` in the Game folder.' });
      const last = String(errOut || '').trim().split('\n').pop();
      resolve({ ok: false, message: `The Game Engine editor did not start: ${last || err.message}` });
    });
  });
}

module.exports = { status, open, gameEngineRoot };
