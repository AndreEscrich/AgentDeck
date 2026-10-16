// Unity assets in words, for the Asset changes list under a task's Changes
// card (assetsSection in renderer/diffview.js). Unity saves prefabs, scenes,
// materials, animations and most other assets as YAML: one document per
// object (a game object, a component, a prefab instance), each with an id
// (its fileID). The asset before and after the task (rebuilt from the
// session's diffs, see versions in undo.js) is read into those objects, and
// the two are compared object by object:
//   - game objects added or removed, with their place in the hierarchy
//   - components added or removed (scripts by their class name)
//   - values that changed, with readable names ("Size delta (230, 300) →
//     (240, 300)") and references named after the object or asset they
//     point to
//   - the overrides of nested prefabs
// Scripts and assets are named from the project's .meta files (their guid),
// read once per project.

const fs = require('fs');
const path = require('path');
const { versions } = require('./undo');

// ---------- reading the YAML ----------

// "--- !u!114 &1234" starts an object; the next line names its class.
// Returns Map(fileID -> { classId, type, stripped, props: Map(path -> value) }).
function parseUnity(text) {
  const objects = new Map();
  const lines = text.split(/\r?\n/);
  let cur = null;
  let stack = [];
  let counters = new Map();
  let lastKey = null;
  for (const raw of lines) {
    const head = /^--- !u!(\d+) &(-?\d+)( stripped)?/.exec(raw);
    if (head) {
      cur = { classId: Number(head[1]), type: null, stripped: !!head[3], props: new Map() };
      objects.set(head[2], cur);
      stack = [];
      counters = new Map();
      lastKey = null;
      continue;
    }
    if (!cur || !raw.trim() || raw.startsWith('%')) continue;
    if (!cur.type) {
      const m = /^(\w+):\s*$/.exec(raw);
      if (m) { cur.type = m[1]; continue; }
    }
    let indent = raw.length - raw.trimStart().length;
    let body = raw.slice(indent);
    if (body.startsWith('- ') || body === '-') {
      // A list item: it belongs to the key at its indent (or above).
      while (stack.length && (stack[stack.length - 1].indent > indent || (stack[stack.length - 1].indent === indent && stack[stack.length - 1].item))) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].path : '';
      const n = counters.get(parent) || 0;
      counters.set(parent, n + 1);
      const itemPath = `${parent}[${n}]`;
      body = body.slice(2);
      indent += 2;
      stack.push({ indent, path: itemPath, item: true });
      if (!body.trim()) continue;
      if (!/^[\w.-]+:(\s|$)/.test(body)) { cur.props.set(itemPath, body.trim()); lastKey = itemPath; continue; }
    }
    const kv = /^([\w.-]+):\s?(.*)$/.exec(body);
    if (!kv) {
      // A string that goes on over several lines.
      if (lastKey) cur.props.set(lastKey, `${cur.props.get(lastKey) || ''} ${body.trim()}`.trim());
      continue;
    }
    while (stack.length && (stack[stack.length - 1].indent > indent || (stack[stack.length - 1].indent === indent && !stack[stack.length - 1].item))) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].path : '';
    const keyPath = parent ? `${parent}.${kv[1]}` : kv[1];
    if (kv[2] === '' ) {
      stack.push({ indent, path: keyPath, item: false });
      cur.props.set(keyPath, '');
    } else {
      cur.props.set(keyPath, kv[2].trim());
    }
    lastKey = keyPath;
  }
  return objects;
}

const ref = v => {
  const m = /\{\s*fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-f]{32}))?/.exec(v || '');
  return m ? { fileID: m[1], guid: m[2] || null } : null;
};

// ---------- names from the project's .meta files ----------

const guidMaps = new Map();   // project folder -> { at, promise: Map(guid -> path) }

function projectRoot(cwd, file) {
  let dir = path.dirname(path.resolve(cwd, file));
  for (let i = 0; i < 12 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings'))) return dir;
  }
  return null;
}

async function walkMeta(dir, out, depth = 0) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  const metas = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth < 14 && !e.name.startsWith('.')) await walkMeta(path.join(dir, e.name), out, depth + 1);
    } else if (e.name.endsWith('.meta')) metas.push(path.join(dir, e.name));
  }
  await Promise.all(metas.map(async m => {
    try {
      const fh = await fs.promises.open(m, 'r');
      const buf = Buffer.alloc(200);
      const { bytesRead } = await fh.read(buf, 0, 200, 0);
      await fh.close();
      const g = /guid:\s*([0-9a-f]{32})/.exec(buf.slice(0, bytesRead).toString('utf8'));
      if (g) out.set(g[1], m.slice(0, -5));
    } catch { /* unreadable */ }
  }));
}

function guidMap(root) {
  if (!root) return Promise.resolve(new Map());
  const hit = guidMaps.get(root);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.promise;
  const promise = (async () => {
    const out = new Map();
    for (const sub of ['Assets', 'Packages', path.join('Library', 'PackageCache')]) await walkMeta(path.join(root, sub), out);
    return out;
  })();
  guidMaps.set(root, { at: Date.now(), promise });
  return promise;
}

// ---------- words ----------

const SKIP = /^(serializedVersion|m_ObjectHideFlags|m_CorrespondingSourceObject|m_PrefabInstance|m_PrefabAsset|m_Children|m_Component|m_RootOrder|m_LocalEulerAnglesHint|m_GameObject|m_Script|m_EditorHideFlags|m_EditorClassIdentifier|m_Father|m_ConstrainProportionsScale)(\b|\.|\[)/;

// "m_SizeDelta" -> "Size delta", "m_Padding.m_Left" -> "Padding › Left".
function label(key) {
  return key.split('.').map(part => part
    .replace(/^m_/, '')
    .replace(/\[(\d+)\]/g, (_, n) => ` #${Number(n) + 1}`)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, c => c.toUpperCase()))
    .join(' › ');
}

function grouped() {
  const g = new Map();   // group heading -> lines
  const add = (heading, line) => {
    if (!g.has(heading)) g.set(heading, []);
    if (g.get(heading).length < 60) g.get(heading).push(line);
  };
  return { g, add };
}

async function describeAsset(cwd, file) {
  if (!file || typeof file.path !== 'string') return { error: 'No file.' };
  const v = await versions(cwd, file);
  if (v.error) return { error: v.error };
  const beforeText = (v.before || []).join('\n');
  const afterText = (v.after || []).join('\n');
  if (!/^%YAML|--- !u!/m.test(afterText || beforeText)) return { error: 'This asset is not in Unity\'s text format, so there is no list of what changed in it.' };
  const before = parseUnity(beforeText);
  const after = parseUnity(afterText);
  const root = projectRoot(cwd || '', file.path);
  const guids = await guidMap(root).catch(() => new Map());
  const assetName = g => {
    const p = guids.get(g);
    return p ? path.basename(p) : `an asset (${g.slice(0, 8)}…)`;
  };

  // Names and places in the hierarchy, in one version.
  const naming = objs => {
    const transformOf = new Map();   // game object id -> its transform id
    for (const [id, o] of objs) {
      if (o.type === 'Transform' || o.type === 'RectTransform') {
        const go = ref(o.props.get('m_GameObject'));
        if (go) transformOf.set(go.fileID, id);
      }
    }
    // A nested prefab's objects are "stripped": their name is in its overrides.
    const instanceName = new Map();
    for (const [id, o] of objs) {
      if (o.classId !== 1001) continue;
      for (const [k, val] of o.props) {
        if (k.endsWith('.propertyPath') && val === 'm_Name') {
          const value = o.props.get(k.replace(/propertyPath$/, 'value'));
          if (value) instanceName.set(id, value);
        }
      }
      if (!instanceName.has(id)) {
        const src = ref(o.props.get('m_SourcePrefab'));
        if (src?.guid) instanceName.set(id, assetName(src.guid).replace(/\.prefab$/, ''));
      }
    }
    const nameOf = goId => {
      const o = objs.get(goId);
      if (!o) return '?';
      if (o.props.get('m_Name')) return o.props.get('m_Name');
      const inst = ref(o.props.get('m_PrefabInstance'));
      return (inst && instanceName.get(inst.fileID)) || '(nested prefab)';
    };
    const pathOf = (goId, depth = 0) => {
      const t = objs.get(transformOf.get(goId));
      const father = t && ref(t.props.get('m_Father'));
      if (!father || father.fileID === '0' || depth > 30) return nameOf(goId);
      const fatherGo = ref(objs.get(father.fileID)?.props.get('m_GameObject'));
      return fatherGo ? `${pathOf(fatherGo.fileID, depth + 1)}/${nameOf(goId)}` : nameOf(goId);
    };
    // Where a nested prefab sits: the path of its parent, then its name.
    const instancePath = instId => {
      const inst = objs.get(instId);
      const parent = inst && ref(inst.props.get('m_Modification.m_TransformParent'));
      const parentGo = parent && parent.fileID !== '0' ? ref(objs.get(parent.fileID)?.props.get('m_GameObject')) : null;
      const name = instanceName.get(instId) || '(nested prefab)';
      return parentGo ? `${pathOf(parentGo.fileID)}/${name}` : name;
    };
    return { nameOf, pathOf, instancePath };
  };
  const nb = naming(before);
  const na = naming(after);
  const pathIn = (id, side) => (side === 'before' ? nb : na).pathOf(id);

  const componentName = o => {
    if (o.type !== 'MonoBehaviour') return o.type || `Object ${o.classId}`;
    const s = ref(o.props.get('m_Script'));
    if (s?.guid && guids.has(s.guid)) return path.basename(guids.get(s.guid)).replace(/\.cs$/, '');
    return 'Script';
  };
  const ownerOf = (o, side) => {
    const go = ref(o.props.get('m_GameObject'));
    if (go && go.fileID !== '0') return pathIn(go.fileID, side);
    // An object of a nested prefab: named after that prefab where it sits.
    const inst = ref(o.props.get('m_PrefabInstance'));
    if (inst && inst.fileID !== '0') return (side === 'before' ? nb : na).instancePath(inst.fileID);
    return null;
  };
  const value = (raw, side) => {
    if (raw == null || raw === '') return '—';
    const r = ref(raw);
    if (r) {
      if (r.fileID === '0') return 'none';
      if (r.guid) return assetName(r.guid);
      const target = (side === 'before' ? before : after).get(r.fileID);
      if (target?.type === 'GameObject') return pathIn(r.fileID, side);
      if (target) return `${componentName(target)} on ${ownerOf(target, side) || '?'}`;
      return 'an object';
    }
    const vec = /^\{\s*([xyzw]: [^,}]+(?:,\s*[xyzw]: [^,}]+)*)\s*\}$/.exec(raw);
    if (vec) return `(${vec[1].split(',').map(p => p.split(':')[1].trim()).join(', ')})`;
    const col = /^\{\s*r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\}$/.exec(raw);
    if (col) return `rgba(${[col[1], col[2], col[3]].map(n => Math.round(Number(n) * 255)).join(', ')}, ${Number(col[4]).toFixed(2).replace(/\.?0+$/, '')})`;
    return raw.length > 90 ? `${raw.slice(0, 87)}…` : raw;
  };

  const { g, add } = grouped();
  const ids = new Set([...before.keys(), ...after.keys()]);
  let count = 0;
  for (const id of ids) {
    const a = before.get(id);
    const b = after.get(id);
    const o = b || a;
    if (o.stripped) continue;
    if (o.type === 'GameObject') {
      if (!a) { add(pathIn(id, 'after'), '+ Added this game object'); count++; continue; }
      if (!b) { add(pathIn(id, 'before'), '− Removed this game object'); count++; continue; }
      const heading = pathIn(id, 'after');
      if (a.props.get('m_Name') !== b.props.get('m_Name')) { add(heading, `~ Renamed from "${a.props.get('m_Name')}"`); count++; }
      if (a.props.get('m_IsActive') !== b.props.get('m_IsActive')) { add(heading, b.props.get('m_IsActive') === '1' ? '~ Turned on' : '~ Turned off'); count++; }
      for (const k of ['m_Layer', 'm_TagString', 'm_StaticEditorFlags']) {
        if (a.props.get(k) !== b.props.get(k)) { add(heading, `~ ${label(k)}: ${value(a.props.get(k))} → ${value(b.props.get(k))}`); count++; }
      }
      continue;
    }
    if (o.classId === 1001) {
      // A nested prefab: its overrides, by target object and property.
      const mods = x => {
        const out = new Map();
        if (!x) return out;
        for (const [k, val] of x.props) {
          const m = /^(m_Modification\.m_Modifications\[\d+\])\.propertyPath$/.exec(k);
          if (!m) continue;
          const t = ref(x.props.get(`${m[1]}.target`));
          const objRef = x.props.get(`${m[1]}.objectReference`);
          const v = x.props.get(`${m[1]}.value`);
          out.set(`${t?.fileID || '?'}|${val}`, { prop: val, value: objRef && ref(objRef)?.fileID !== '0' ? objRef : v });
        }
        return out;
      };
      const ma = mods(a);
      const mb = mods(b);
      const src = ref((b || a).props.get('m_SourcePrefab'));
      const prefab = src?.guid ? assetName(src.guid) : 'a prefab';
      const heading = (b ? na : nb).instancePath(id);
      // A new or removed one in a line; overrides only for one that stays.
      if (!a) { add(heading, `+ Added nested prefab ${prefab}${mb.size ? ` (${mb.size} override${mb.size === 1 ? '' : 's'})` : ''}`); count++; continue; }
      if (!b) { add(heading, `− Removed nested prefab ${prefab}`); count++; continue; }
      for (const [k, m] of mb) {
        const old = ma.get(k);
        if (!old) { add(heading, `+ Override ${label(m.prop)}: ${value(m.value, 'after')}`); count++; }
        else if (old.value !== m.value) { add(heading, `~ Override ${label(m.prop)}: ${value(old.value, 'before')} → ${value(m.value, 'after')}`); count++; }
      }
      for (const [k, m] of ma) if (!mb.has(k)) { add(heading, `− Override removed: ${label(m.prop)}`); count++; }
      continue;
    }
    // A component (or any other object): added, removed, or its values.
    const owner = ownerOf(b || a, b ? 'after' : 'before');
    const heading = owner || componentName(o);
    const what = componentName(o);
    if (!a) { add(heading, `+ Added ${what}`); count++; continue; }
    if (!b) { add(heading, `− Removed ${what}`); count++; continue; }
    const keys = new Set([...a.props.keys(), ...b.props.keys()]);
    const changes = [];
    for (const k of keys) {
      if (SKIP.test(k)) continue;
      const x = a.props.get(k);
      const y = b.props.get(k);
      if (x === y || (x === '' && y === undefined) || (y === '' && x === undefined)) continue;
      if (y === undefined) changes.push(`− ${what} › ${label(k)} (was ${value(x, 'before')})`);
      else if (x === undefined) changes.push(`+ ${what} › ${label(k)}: ${value(y, 'after')}`);
      else changes.push(`~ ${what} › ${label(k)}: ${value(x, 'before')} → ${value(y, 'after')}`);
    }
    // Moved in the hierarchy.
    if ((o.type === 'Transform' || o.type === 'RectTransform') && a.props.get('m_Father') !== b.props.get('m_Father')) {
      const f = ref(b.props.get('m_Father'));
      const fgo = f && ref(after.get(f.fileID)?.props.get('m_GameObject'));
      changes.unshift(`~ Moved under ${fgo ? pathIn(fgo.fileID, 'after') : 'the root'}`);
    }
    for (const c of changes) add(heading, c);
    count += changes.length;
  }
  // Game objects first, in hierarchy order; nested prefabs and the rest after.
  const groups = [...g].map(([heading, lines]) => ({ heading, lines }))
    .sort((x, y) => x.heading.localeCompare(y.heading));
  return {
    groups,
    count,
    note: !v.before ? 'A new asset: everything in it is listed as added.' : !v.after ? 'The asset was deleted.' : null,
  };
}

module.exports = { describeAsset, parseUnity };
