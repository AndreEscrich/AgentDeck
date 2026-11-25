const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUNDLED = path.join(__dirname, '..', 'plugins', 'agent-hub');
const SKILL = path.join('skills', 'pm-comment', 'SKILL.md');
const BASE = '.bundled-sha';

let userDir = null;

function setUserDataDir(dir) {
  userDir = dir ? path.join(dir, 'plugins', 'agent-hub') : null;
}

const hash = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const hasCopy = () => !!userDir && fs.existsSync(path.join(userDir, SKILL));

function pluginDir() {
  return hasCopy() ? userDir : BUNDLED;
}

function status() {
  if (!hasCopy()) return { custom: false, file: path.join(BUNDLED, SKILL) };
  let base = '';
  try { base = fs.readFileSync(path.join(userDir, BASE), 'utf8').trim(); } catch {}
  return { custom: true, file: path.join(userDir, SKILL), bundledChanged: !!base && base !== hash(path.join(BUNDLED, SKILL)) };
}

function customize() {
  if (!userDir) throw new Error('Agent Hub\'s settings folder is not known yet');
  if (!hasCopy()) {
    fs.rmSync(userDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(userDir), { recursive: true });
    fs.cpSync(BUNDLED, userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, BASE), hash(path.join(BUNDLED, SKILL)));
  }
  return status();
}

function reset() {
  if (userDir) fs.rmSync(userDir, { recursive: true, force: true });
  return status();
}

module.exports = { setUserDataDir, pluginDir, status, customize, reset, BUNDLED };
