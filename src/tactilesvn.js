// TactileSVN (Tactile's own SVN client), when it is installed: a button
// opens an agent's working copy in it. TactileSVN takes the project on its
// command line (--project=<working copy root>). When it already has that
// project open, the new process hands it to the running app, which brings
// that window or tab to the front and the new process ends; otherwise it
// opens the project.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { repoOf } = require('./repos');

let found;   // the program's path, or null; looked up once

function program() {
  if (found !== undefined) return found;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'TactileSVN', 'TactileSVN.exe'),
       path.join(process.env.ProgramFiles || 'C:\\Program Files', 'TactileSVN', 'TactileSVN.exe')]
    : ['/Applications/TactileSVN.app/Contents/MacOS/TactileSVN', path.join(home, 'Applications', 'TactileSVN.app', 'Contents', 'MacOS', 'TactileSVN')];
  found = candidates.find(p => p && fs.existsSync(p)) || null;
  // Somewhere else on a Mac: Spotlight knows it by its bundle id.
  if (!found && process.platform === 'darwin') {
    try {
      const app = execFileSync('mdfind', ['kMDItemCFBundleIdentifier == "com.tactilegames.tactile-svn"'], { timeout: 3000, encoding: 'utf8' })
        .split('\n').find(p => p.endsWith('.app') && !p.includes('/Downloads/'));
      const exe = app && path.join(app, 'Contents', 'MacOS', 'TactileSVN');
      if (exe && fs.existsSync(exe)) found = exe;
    } catch { /* not found */ }
  }
  return found;
}

// { available, root }: available when TactileSVN is installed and the folder
// is in an SVN working copy (root: the working copy's top folder).
function status(cwd) {
  const repo = cwd ? repoOf(cwd) : null;
  const svn = !!repo && fs.existsSync(path.join(repo.root, '.svn'));
  return { available: svn && !!program(), root: svn ? repo.root : null };
}

function open(cwd) {
  const { available, root } = status(cwd);
  if (!available) return { ok: false, message: program() ? 'This folder is not an SVN working copy.' : 'TactileSVN is not installed.' };
  try {
    spawn(program(), [`--project=${root}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, root };
  } catch (err) {
    return { ok: false, message: `Could not start TactileSVN: ${err.message}` };
  }
}

module.exports = { status, open };
