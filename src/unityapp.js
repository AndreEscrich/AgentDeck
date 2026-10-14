// The Unity Editor for a group's or an agent's folder: whether it is open,
// bringing its window to the front, or starting it (the "Open Unity" /
// "Focus Unity" buttons).
//
// An open editor is found by the project folder on its command line
// (Unity -projectPath <folder>); Unity's helper processes for the same
// project run with -batchMode and are left out. A closed one is started with
// the editor version the project names in ProjectSettings/ProjectVersion.txt,
// from Unity Hub's install folder (or the folder Unity Hub was told to use).

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unityRoot } = require('./setupcheck');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function run(cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? '' : String(out)));
  });
}

const same = (a, b) => {
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// [{ pid, project }] for every open Unity Editor (not its helpers).
async function editors() {
  const list = [];
  if (isWin) {
    const out = await run('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"]);
    for (const line of out.split(/\r?\n/)) {
      const [pid, cmd = ''] = line.split('\t');
      if (!pid || /-batchMode/i.test(cmd)) continue;
      const m = /-projectPath\s+(?:"([^"]+)"|(\S+))/i.exec(cmd);
      if (m) list.push({ pid: Number(pid), project: m[1] || m[2] });
    }
  } else {
    const out = await run('ps', ['-axo', 'pid=,command=']);
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || !/Unity(\.app\/Contents\/MacOS\/Unity|Editor\/Unity)\b/.test(m[2]) || /-batchMode/i.test(m[2])) continue;
      const p = /-projectPath\s+(.+?)(?=\s+-[A-Za-z]|$)/i.exec(m[2]);
      if (p) list.push({ pid: Number(m[1]), project: p[1].trim().replace(/^"|"$/g, '') });
    }
  }
  return list;
}

// { unity: false } for a folder that is not a Unity project, else
// { unity: true, root, running, pid, version }.
async function status(cwd) {
  const root = unityRoot(cwd);
  if (!root) return { unity: false };
  const open = (await editors()).find(e => same(e.project, root));
  return { unity: true, root, running: !!open, pid: open?.pid || null, version: projectVersion(root) };
}

function projectVersion(root) {
  try {
    return /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))?.[1] || null;
  } catch {
    return null;
  }
}

// The Unity Editor program for a version, where Unity Hub installs it.
function editorFor(version) {
  if (!version) return null;
  const roots = isWin ? ['C:\\Program Files\\Unity\\Hub\\Editor'] : isMac ? ['/Applications/Unity/Hub/Editor'] : [path.join(os.homedir(), 'Unity', 'Hub', 'Editor')];
  try {
    const hubDir = isWin ? path.join(process.env.APPDATA || '', 'UnityHub') : isMac ? path.join(os.homedir(), 'Library', 'Application Support', 'UnityHub') : path.join(os.homedir(), '.config', 'UnityHub');
    const custom = JSON.parse(fs.readFileSync(path.join(hubDir, 'secondaryInstallPath.json'), 'utf8'));
    if (typeof custom === 'string' && custom) roots.unshift(custom);
  } catch { /* the default folder only */ }
  for (const r of roots) {
    const exe = isWin ? path.join(r, version, 'Editor', 'Unity.exe') : isMac ? path.join(r, version, 'Unity.app', 'Contents', 'MacOS', 'Unity') : path.join(r, version, 'Editor', 'Unity');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

// Brings an open editor's window to the front.
async function focus(pid) {
  if (isMac) {
    // The window of exactly this process (several editors can be open).
    await run('osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}); app.unhide; app.activateWithOptions(3);`]);
    return true;
  }
  if (isWin) {
    await run('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; $h = (Get-Process -Id ${Number(pid)}).MainWindowHandle; [U.W]::ShowWindow($h, 9) | Out-Null; [U.W]::SetForegroundWindow($h) | Out-Null`]);
    return true;
  }
  return false;
}

// Focuses the project's editor when it is open, else starts it. Resolves
// with { ok, action: 'focused' | 'opened', version } or { ok: false, message }.
async function open(cwd) {
  const s = await status(cwd);
  if (!s.unity) return { ok: false, message: 'This folder is not a Unity project.' };
  if (s.running) {
    await focus(s.pid);
    return { ok: true, action: 'focused', version: s.version };
  }
  const exe = editorFor(s.version);
  if (!exe) return { ok: false, message: `Unity ${s.version || '(version unknown)'} is not installed in Unity Hub's folder. Install it with Unity Hub, or open the project from there.` };
  try {
    const child = spawn(exe, ['-projectPath', s.root], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, action: 'opened', version: s.version };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { status, open, editors };
