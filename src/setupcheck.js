// Checks that what the agents need is set up, for the popups that explain
// how to fix it (see setupPopups in renderer/app.js):
//
// - Claude Code itself (claudeStatus).
// - The Unity bridge (unityBridge): the com.tactilegames.unity-mcp package
//   lets agents work in the Unity Editor. It needs Node.js, the package in
//   the project, the package switched on (Tactile → AI → MCPs → Unity MCP →
//   Activated, which copies its server to Library/McpServer and installs
//   it), and a .mcp.json next to Assets that names the "unity" server.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { claudeInfo, childEnv } = require('./platform');

function claudeStatus(config) {
  return claudeInfo(config?.claudePath);
}

// The Unity project for a folder: the folder itself, a Unity folder in it
// (MyGame/Unity), or a folder above it. null when it is not a Unity project.
function unityRoot(cwd) {
  if (!cwd) return null;
  const isUnity = d => fs.existsSync(path.join(d, 'Assets')) && fs.existsSync(path.join(d, 'ProjectSettings'));
  let dir = path.resolve(cwd);
  if (isUnity(dir)) return dir;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && isUnity(path.join(dir, e.name))) return path.join(dir, e.name);
    }
  } catch { /* not readable */ }
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
    if (isUnity(dir)) return dir;
  }
  return null;
}

function nodeVersion(config) {
  return new Promise(resolve => {
    execFile('node', ['--version'], { env: childEnv(config?.env), timeout: 5000 }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}

// { unity: false } for a folder that is not a Unity project, else
// { unity: true, root, ok, steps: [{ id, ok }] } in the order to fix them.
async function unityBridge(config, cwd) {
  const root = unityRoot(cwd);
  if (!root) return { unity: false };
  const read = p => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } };
  const manifest = read('Packages/manifest.json');
  let mcp = null;
  try { mcp = JSON.parse(read('.mcp.json')); } catch { mcp = null; }
  const server = path.join(root, 'Library', 'McpServer');
  const steps = [
    { id: 'node', ok: !!(await nodeVersion(config)) },
    { id: 'package', ok: /"com\.tactilegames\.unity-mcp"/.test(manifest) },
    { id: 'activated', ok: fs.existsSync(path.join(server, 'index.js')) },
    { id: 'installed', ok: fs.existsSync(path.join(server, 'node_modules')) },
    { id: 'mcpJson', ok: !!mcp?.mcpServers?.unity },
  ];
  return { unity: true, root, ok: steps.every(s => s.ok), steps };
}

// Adds the "unity" server to the project's .mcp.json (creating the file
// when there is none), the way the package's README describes it. Only when
// you click "Create .mcp.json" in the popup.
function writeMcpJson(root) {
  if (!root || !fs.existsSync(path.join(root, 'Assets'))) return { ok: false, message: 'Not a Unity project.' };
  const file = path.join(root, '.mcp.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
  if (data?.mcpServers?.unity) return { ok: true };
  data.mcpServers = { ...(data.mcpServers || {}), unity: { command: 'node', args: ['Library/McpServer/index.js'], env: {} } };
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { claudeStatus, unityBridge, unityRoot, writeMcpJson };
