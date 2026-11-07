// Reads TypeScript for the class diagram of an agent's changes, the way
// csharp.js reads C#, and gives the same model (see model there): the types
// the changed files declare (classes, interfaces, enums, type aliases), their
// members, which members the diff touched, and how the types depend on each
// other. TypeScript's own parser reads the code, and imports say which file a
// name comes from (with the tsconfig's paths), so an arrow goes to the type
// that is really meant.
//
// A file's top-level functions and exported constants are one box of their
// own, named after the file (kind module).
//
// Projects on the Game Engine's ECS (CauldronMerge, see its PROJECT.md) get
// their own building blocks, with the roles the C# diagram knows:
// - a feature folder, src/<feature>/ (with schema/<feature>.schema.ts), is
//   the namespace: one container;
// - its index.ts (re-exports only) is the feature's facade, the API other
//   features import from; their arrows end on it;
// - its <feature>.di.ts (the DI module that wires its services) is its
//   composer;
// - a system (defineSystem) is a box of its own, and so is each component,
//   resource, event and data asset (component(…), resource(…), event(…),
//   dataAsset(…)); a system's arrows to them say whether it reads, writes or
//   runs on them.
// Generated files (*.gen.ts) are left out: what they declare comes from the
// schema files, where the arrows go. So is code from outside the project
// (the engine's packages).
//
// model(cwd, files) is what the window asks for (see cs:model in main.js).

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { versions } = require('./undo');
const { diffLines } = require('./csharp');

const TS_FILE = /\.([cm]?tsx?)$/i;

// Unit tests stay out of the diagram, as in csharp.js: Foo.test.ts,
// Foo.spec.tsx, and files in __tests__, test or tests folders. The same rule
// is in diffview.js (isTestPath).
const TEST_PATH = /(^|[\\/])(__tests__|tests?|e2e)[\\/]|\.(test|spec)\.[cm]?tsx?$/i;
const isTestFile = p => TEST_PATH.test(p);

const scriptKind = file => (/x$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const GENERATED = /\.gen\.[cm]?tsx?$/i;
// src/<feature>/index.ts: the feature's facade.
const FACADE_FILE = /(^|[\\/])src[\\/][^\\/]+[\\/]index\.[cm]?tsx?$/i;
// src/<feature>/<feature>.di.ts: the feature's composer.
const COMPOSER_FILE = /\.di\.[cm]?tsx?$/i;
// The schema calls of the ECS and the kind of box each one makes.
const SCHEMA_KINDS = { component: 'component', tag: 'component', resource: 'resource', event: 'event', signal: 'event', dataAsset: 'data' };

// The feature a file belongs to: src/<feature>/…, or schema/<feature>.schema.ts.
// Files right in src are the game's own ('src'); outside src, the folder.
function featureOf(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] || '';
  const schema = /^(.+)\.schema\.[cm]?tsx?$/i.exec(name);
  if (schema && parts[parts.length - 2] === 'schema') return schema[1];
  const src = parts.lastIndexOf('src');
  if (src >= 0) return parts.length > src + 2 ? parts[src + 1] : 'src';
  return parts.slice(0, -1).filter(p => p !== '.').join('.');
}

// Its text on one line, at most max characters.
const short = (text, max = 50) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// "Map<string, number>" with its spaces and line breaks evened out.
const typeText = (node, sf) => (node ? node.getText(sf).replace(/\s+/g, ' ').trim() : '');

// The name after the last dot: Base, ns.Base, Base<T> -> Base.
function lastName(expr) {
  if (!expr) return null;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isQualifiedName(expr)) return expr.right.text;
  if (ts.isExpressionWithTypeArguments(expr)) return lastName(expr.expression);
  return null;
}

// "count: number = 0" -> "number count" (the C# order, which the diagram's
// member labels read: the type, then the name).
function paramsText(params, sf) {
  return (params || []).map(p => `${typeText(p.type, sf) || 'any'} ${p.name.getText(sf)}`).join(', ');
}

const hasModifier = (node, kind) => !!node.modifiers?.some(m => m.kind === kind);

// ---------- one file ----------

// The declarations in one file: [{ name, kind, generic, line, endLine,
// ranges: [[from, to]] (lines), members, bases, nodes: AST nodes to look in
// for the names it uses }], and the file's imports: name -> { spec, name }
// (name: the exported name, 'default', or '*' for import * as).
function parseFile(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const imports = new Map();
  const exportsFrom = [];   // export { X } from './x', export * from './y'
  const decls = [];
  const fileName = path.basename(file).replace(TS_FILE, '').replace(/\.d$/, '');
  let module = null;   // the box of the file's functions and constants
  const memberOf = (node, m) => ({ ...m, line: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()) });

  const classMembers = (members, isInterface) => {
    const out = [];
    for (const m of members) {
      const name = m.name ? m.name.getText(sf) : '';
      if (ts.isConstructorDeclaration(m)) out.push(memberOf(m, { kind: 'ctor', name: 'constructor', type: '', params: paramsText(m.parameters, sf) }));
      else if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) out.push(memberOf(m, { kind: 'method', name, type: typeText(m.type, sf), params: paramsText(m.parameters, sf) }));
      else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        if (!out.some(o => o.kind === 'property' && o.name === name)) out.push(memberOf(m, { kind: 'property', name, type: typeText(m.type, sf) }));
      } else if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
        // A property holding a function is a method: update = (dt: number) => {…}
        const init = m.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) out.push(memberOf(m, { kind: 'method', name, type: typeText(init.type, sf), params: paramsText(init.parameters, sf) }));
        else out.push(memberOf(m, { kind: isInterface ? 'property' : 'field', name, type: typeText(m.type, sf) }));
      } else if (ts.isIndexSignatureDeclaration(m)) out.push(memberOf(m, { kind: 'property', name: '[]', type: typeText(m.type, sf) }));
      else if (ts.isCallSignatureDeclaration(m)) out.push(memberOf(m, { kind: 'method', name: '()', type: typeText(m.type, sf), params: paramsText(m.parameters, sf) }));
    }
    return out;
  };

  const add = (node, d) => {
    decls.push({
      generic: node.typeParameters?.length ? `<${node.typeParameters.map(p => p.name.text).join(',')}>` : '',
      bases: [],
      members: [],
      line: lineOf((node.name || node).getStart(sf)),
      endLine: lineOf(node.getEnd()),
      ranges: [[lineOf(node.getStart(sf)), lineOf(node.getEnd())]],
      nodes: [node],
      exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
      isDefault: hasModifier(node, ts.SyntaxKind.DefaultKeyword),
      ...d,
    });
  };
  const toModule = (node, members, names, exported, isDefault) => {
    if (!module) {
      module = { name: fileName, kind: 'module', generic: '', bases: [], members: [], line: lineOf(node.getStart(sf)), endLine: 0, ranges: [], nodes: [], names: new Set(), exported: false };
      decls.push(module);
    }
    module.members.push(...members);
    module.ranges.push([lineOf(node.getStart(sf)), lineOf(node.getEnd())]);
    module.endLine = Math.max(module.endLine, lineOf(node.getEnd()));
    module.nodes.push(node);
    for (const n of names) module.names.add(n);
    if (exported) module.exported = true;
    if (isDefault) module.isDefault = true;
  };

  // const BoardDrop = defineSystem({ … }): one member per part of its
  // definition (queries, resources, runOn, run), and what it reads, writes
  // and runs on: access, name -> 'reads' | 'writes' | 'runs-on'.
  const addSystem = (s, d, def) => {
    const members = [];
    const access = new Map();
    for (const p of def.properties) {
      const name = p.name ? p.name.getText(sf) : '';
      // Its name is the box's; run(ctx, queries) is the same in every system.
      if (name === 'name') continue;
      if (ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)))) members.push(memberOf(p, { kind: 'method', name, type: '', params: '' }));
      else if (ts.isPropertyAssignment(p)) {
        members.push(memberOf(p, { kind: 'property', name, type: short(p.initializer.getText(sf)) }));
        if (name === 'runOn') for (const n of (ts.isArrayLiteralExpression(p.initializer) ? p.initializer.elements : [p.initializer])) {
          const target = lastName(n);
          if (target && !access.has(target)) access.set(target, 'runs-on');
        }
      }
    }
    const walk = node => {
      if (ts.isCallExpression(node) && ['read', 'write'].includes(lastName(node.expression)) && node.arguments[0]) {
        const target = lastName(node.arguments[0]);
        if (target && access.get(target) !== 'writes') access.set(target, lastName(node.expression) === 'write' ? 'writes' : 'reads');
      }
      ts.forEachChild(node, walk);
    };
    walk(def);
    add(s, { name: d.name.text, kind: 'system', line: lineOf(d.name.getStart(sf)), members, access });
  };
  // const BoardPiece = component('BoardPiece', { column: i32(), … }): a field per entry.
  const addSchema = (s, d, call, kind) => {
    const shape = call.arguments.find(a => ts.isObjectLiteralExpression(a));
    const members = (shape?.properties || []).map(p => {
      const init = ts.isPropertyAssignment(p) ? p.initializer : null;
      const type = init && ts.isCallExpression(init) ? lastName(init.expression) : init ? short(init.getText(sf), 30) : '';
      return memberOf(p, { kind: 'field', name: p.name ? p.name.getText(sf) : '', type });
    });
    add(s, { name: d.name.text, kind, line: lineOf(d.name.getStart(sf)), members });
  };
  const exportLines = [];   // the export … from statements (a facade's members)

  const visit = (statements, outer) => {
    for (const s of statements) {
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        const spec = s.moduleSpecifier.text;
        const c = s.importClause;
        if (!c) continue;
        if (c.name) imports.set(c.name.text, { spec, name: 'default' });
        const b = c.namedBindings;
        if (b && ts.isNamespaceImport(b)) imports.set(b.name.text, { spec, name: '*' });
        else if (b) for (const e of b.elements) imports.set(e.name.text, { spec, name: (e.propertyName || e.name).text });
      } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
        const spec = s.moduleSpecifier.text;
        if (!s.exportClause) {
          exportsFrom.push({ spec, all: true });
          exportLines.push(memberOf(s, { kind: 'field', name: `* from ${spec}`, type: '' }));
        } else if (ts.isNamedExports(s.exportClause)) {
          for (const e of s.exportClause.elements) {
            exportsFrom.push({ spec, name: (e.propertyName || e.name).text, as: e.name.text });
            exportLines.push(memberOf(e, { kind: 'field', name: e.name.text, type: '', spec, exported: (e.propertyName || e.name).text }));
          }
        }
      } else if (ts.isClassDeclaration(s)) {
        const bases = [];
        const implementsNames = [];
        for (const h of s.heritageClauses || []) {
          for (const t of h.types) {
            const n = lastName(t.expression);
            if (!n) continue;
            (h.token === ts.SyntaxKind.ImplementsKeyword ? implementsNames : bases).push(n);
          }
        }
        add(s, { name: s.name?.text || fileName, kind: 'class', abstract: hasModifier(s, ts.SyntaxKind.AbstractKeyword), outer, bases: [...bases, ...implementsNames], members: classMembers(s.members, false) });
      } else if ((ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && !outer && !hasModifier(s, ts.SyntaxKind.ExportKeyword)) {
        // A file's own local shape (type Held = { … } in a system's file) is
        // a detail of that file, not a type of the feature.
        continue;
      } else if (ts.isInterfaceDeclaration(s)) {
        const bases = (s.heritageClauses || []).flatMap(h => h.types.map(t => lastName(t.expression))).filter(Boolean);
        add(s, { name: s.name.text, kind: 'interface', outer, bases, members: classMembers(s.members, true) });
      } else if (ts.isEnumDeclaration(s)) {
        add(s, { name: s.name.text, kind: 'enum', outer, members: s.members.map(m => memberOf(m, { kind: 'value', name: m.name.getText(sf), type: '' })) });
      } else if (ts.isTypeAliasDeclaration(s)) {
        // type Position = { x: number; y: number } has members; A & B & { … }
        // has bases too; anything else is said in a note.
        const parts = ts.isIntersectionTypeNode(s.type) ? s.type.types : [s.type];
        const members = [];
        const bases = [];
        for (const p of parts) {
          if (ts.isTypeLiteralNode(p)) members.push(...classMembers(p.members, true));
          else if (ts.isTypeReferenceNode(p)) bases.push(lastName(p.typeName));
        }
        if (!members.length && !bases.length) {
          const text = typeText(s.type, sf);
          members.push(memberOf(s.type, { kind: 'note', name: `= ${text.length > 60 ? text.slice(0, 59) + '…' : text}`, type: '' }));
        }
        add(s, { name: s.name.text, kind: 'type', outer, bases: bases.filter(Boolean), members });
      } else if (ts.isModuleDeclaration(s) && s.body && ts.isModuleBlock(s.body)) {
        visit(s.body.statements, s.name.getText(sf));
      } else if (ts.isFunctionDeclaration(s) && s.body) {
        const name = s.name?.text || 'default';
        toModule(s, [memberOf(s, { kind: 'method', name, type: typeText(s.type, sf), params: paramsText(s.parameters, sf) })], [name],
          hasModifier(s, ts.SyntaxKind.ExportKeyword), hasModifier(s, ts.SyntaxKind.DefaultKeyword));
      } else if (ts.isVariableStatement(s)) {
        const members = [];
        const names = [];
        const exported = hasModifier(s, ts.SyntaxKind.ExportKeyword);
        for (const d of s.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const name = d.name.text;
          const init = d.initializer;
          const call = init && ts.isCallExpression(init) ? lastName(init.expression) : null;
          if (call === 'defineSystem' && init.arguments[0] && ts.isObjectLiteralExpression(init.arguments[0])) addSystem(s, d, init.arguments[0]);
          else if (SCHEMA_KINDS[call]) addSchema(s, d, init, SCHEMA_KINDS[call]);
          else if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            names.push(name);
            members.push(memberOf(d, { kind: 'method', name, type: typeText(init.type, sf), params: paramsText(init.parameters, sf) }));
          } else if (exported) {
            // A file's own constants (scratch objects, limits) are details;
            // what it exports is part of its box: const Position = defineComponent({ … })
            // says what it is by its call.
            names.push(name);
            members.push(memberOf(d, { kind: 'field', name, type: typeText(d.type, sf) || (call ? `${call}(…)` : '') }));
          }
        }
        if (members.length) toModule(s, members, names, exported, false);
      } else if (ts.isExportAssignment(s) && module) {
        module.isDefault = true;
      }
    }
  };
  visit(sf.statements, null);
  // The feature's index.ts: its facade, named after the feature, with what it exports.
  if (FACADE_FILE.test(file) && exportLines.length) {
    const feature = path.basename(path.dirname(file));
    decls.push({
      name: feature, kind: 'module', role: 'facade', generic: '', bases: [], members: exportLines,
      line: exportLines[0].line, endLine: exportLines[exportLines.length - 1].endLine,
      ranges: exportLines.map(m => [m.line, m.endLine]), nodes: [], exported: true,
    });
  }
  // <feature>.di.ts: its functions and constants wire the feature's services.
  if (COMPOSER_FILE.test(file) && module) module.role = 'composer';
  // A system's file with helpers of its own (nothing else exports them):
  // they are part of the system, in its box.
  const system = decls.find(d => d.kind === 'system');
  if (system && module && !module.exported && !module.role) {
    system.members.push(...module.members);
    system.ranges.push(...module.ranges);
    system.nodes.push(...module.nodes);
    system.endLine = Math.max(system.endLine, module.endLine);
    decls.splice(decls.indexOf(module), 1);
  }
  return { sf, decls, imports, exportsFrom };
}

// The names a declaration uses, with their lines: 'Name' for a name of the
// file or an import, 'C.Name' for a name of import * as C.
function usedNames(decl, sf, known) {
  const words = new Map();
  const note = (word, node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (!words.has(word)) words.set(word, new Set());
    words.get(word).add(line);
  };
  const walk = node => {
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const name = node.text;
      // Not the name of what is declared, a property (x.Name), or a key.
      const isName = p && p.name === node && !ts.isPropertyAccessExpression(p) && !ts.isExpressionWithTypeArguments(p);
      const isMember = p && ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isQualifiedName(p) && p.right === node));
      if (!isName && !isMember && known(name)) {
        // C.Position, with C an import * as C.
        const access = p && ((ts.isPropertyAccessExpression(p) && p.expression === node && p.name) || (ts.isQualifiedName(p) && p.left === node && p.right));
        note(access && known(name) === '*' ? `${name}.${access.text}` : name, node);
      }
      return;
    }
    ts.forEachChild(node, walk);
  };
  for (const n of decl.nodes) {
    // The declaration's own name is not a use.
    ts.forEachChild(n, child => { if (child !== n.name) walk(child); });
  }
  return words;
}

// ---------- the project ----------

// The compiler options of the tsconfig around a file (for paths and baseUrl),
// by the tsconfig's folder.
const configs = new Map();
function optionsFor(file) {
  const found = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  if (!found) return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: false };
  if (!configs.has(found)) {
    let options = {};
    try {
      const read = ts.readConfigFile(found, ts.sys.readFile);
      options = ts.parseJsonConfigFileContent(read.config || {}, ts.sys, path.dirname(found), undefined, found).options;
    } catch { /* an unreadable tsconfig: the defaults */ }
    // Node16 and NodeNext want file extensions in imports; Bundler finds both.
    if (!options.moduleResolution || options.moduleResolution === ts.ModuleResolutionKind.Classic) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    configs.set(found, options);
  }
  return configs.get(found);
}

// The folder of the tsconfig around a file: the project.
function projectOf(file) {
  const found = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  return found ? path.resolve(path.dirname(found)) : null;
}

// The project's own file an import means, or null (a package, a file
// outside the project such as the engine's, or not found).
function resolveImport(spec, fromFile) {
  try {
    const r = ts.resolveModuleName(spec, fromFile, optionsFor(fromFile), ts.sys).resolvedModule;
    if (!r || r.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(r.resolvedFileName)) return null;
    const file = path.resolve(r.resolvedFileName);
    const root = projectOf(fromFile);
    if (root && !file.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return null;
    return file;
  } catch {
    return null;
  }
}

// What a generated file (schema.gen.ts) declares is written in the
// project's schema/*.schema.ts: the file there that declares a name.
function schemaFiles(root) {
  try {
    const dir = path.join(root, 'schema');
    return fs.readdirSync(dir).filter(f => /\.schema\.[cm]?tsx?$/i.test(f)).map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

// Files outside the changes, read once (until they change on disk).
const parsedFiles = new Map();   // file -> { mtime, parsed }
function parseFromDisk(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = parsedFiles.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit.parsed;
  let parsed = null;
  try { parsed = parseFile(fs.readFileSync(file, 'utf8'), file); } catch { parsed = null; }
  if (parsedFiles.size > 2000) parsedFiles.clear();
  parsedFiles.set(file, { mtime: stat.mtimeMs, parsed });
  return parsed;
}

// The declaration a file exports under a name ('default' too), following
// re-exports (an index.ts that gathers a folder) a few files deep.
// Returns { file, decl } or null.
function exportedDecl(file, name, parsedOf, depth = 0) {
  if (GENERATED.test(file)) {
    const root = projectOf(file);
    for (const schema of root ? schemaFiles(root) : []) {
      const decl = parsedOf(schema)?.decls.find(d => d.name === name && d.kind !== 'module');
      if (decl) return { file: schema, decl };
    }
    return null;
  }
  const parsed = parsedOf(file);
  if (!parsed || depth > 4) return null;
  const own = parsed.decls.find(d => (name === 'default' ? d.isDefault : (d.name === name && d.kind !== 'module') || d.names?.has(name)));
  if (own) return { file, decl: own };
  for (const e of parsed.exportsFrom) {
    if (!e.all && e.as !== name) continue;
    const target = resolveImport(e.spec, file);
    if (!target) continue;
    const hit = exportedDecl(target, e.all ? name : e.name, parsedOf, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ---------- the model ----------

const MAX_CONTEXT = 14;


// files: [{ path, status, lines }] from a Changes card (TypeScript files
// only). Resolves with the same { nodes, edges, testsLeftOut } as csharp.js.
async function model(cwd, files) {
  const changed = [];   // { node, decl, parsed, added, abs }
  let testsLeftOut = 0;
  const byFile = new Map();   // absolute path -> the parsed file as the task left it
  for (const f of (Array.isArray(files) ? files : []).slice(0, 500)) {
    if (!f || typeof f.path !== 'string' || !TS_FILE.test(f.path)) continue;
    if (isTestFile(f.path)) { testsLeftOut++; continue; }
    // Generated from the schema (see exportedDecl): nobody wrote it.
    if (GENERATED.test(f.path)) continue;
    // The file as the agent left it (see versions in undo.js).
    const v = await versions(cwd, f);
    if (v.error) continue;
    const abs = path.resolve(cwd || '', f.path);
    const text = (f.status === 'del' ? v.before : v.after || []).join('\n');
    let parsed;
    try { parsed = parseFile(text, abs); } catch { continue; }
    if (f.status !== 'del') byFile.set(abs, parsed);
    let before = null;
    if (f.status === 'mod' && v.before) {
      try { before = parseFile(v.before.join('\n'), abs); } catch { before = null; }
    }
    const diff = diffLines(f);
    const changedLines = new Set(diff.added.keys());
    for (const r of diff.removed) changedLines.add(r.at);
    const inRanges = (ranges, l) => ranges.some(([a, b]) => l >= a - 1 && l <= b);
    for (const d of parsed.decls) {
      const touched = f.status === 'new' || f.status === 'del' || [...changedLines].some(l => inRanges(d.ranges, l));
      const allNew = f.status === 'new' || d.ranges.every(([a, b]) => [...Array(b - a + 1).keys()].every(k => diff.added.has(a + k)));
      const status = f.status === 'del' ? 'del' : allNew ? 'new' : touched ? 'mod' : 'same';
      const members = d.members.map(m => {
        let change = null;
        if (status === 'new') change = 'new';
        else if (status === 'del') change = 'del';
        else {
          let any = false;
          let all = true;
          for (let l = m.line; l <= m.endLine; l++) {
            if (changedLines.has(l)) any = true;
            if (!diff.added.has(l)) all = false;
          }
          if (all) change = 'new';
          else if (any) change = 'mod';
        }
        return { name: m.name, kind: m.kind, type: m.type, params: m.params, change, line: m.line };
      });
      // Members that are gone: the declaration as it was before has them.
      const was = status === 'mod' && before ? before.decls.find(b => b.name === d.name && b.kind === d.kind && (b.outer || '') === (d.outer || '')) : null;
      if (was) {
        const names = new Set(d.members.map(m => m.name));
        for (const m of was.members) {
          if (names.has(m.name)) continue;
          names.add(m.name);
          members.push({ name: m.name, kind: m.kind, type: m.type, params: m.params, change: 'del', line: d.line });
        }
      }
      changed.push({
        node: {
          id: `${f.path}#${d.name}#${d.line}`,
          name: d.name,
          kind: d.kind,
          generic: d.generic,
          namespace: featureOf(f.path),
          role: d.role || null,
          status,
          file: f.path,
          folder: path.dirname(f.path).split(path.sep).join('/'),
          line: d.line,
          members,
          bases: d.bases,
          outer: d.outer || null,
        },
        decl: d,
        parsed,
        abs,
        added: diff.added,
      });
    }
  }
  // Deleted files: their declarations are found by name in them, not on disk.
  const nodeOfDecl = new Map(changed.map(c => [c.decl, c.node]));
  const parsedOf = file => byFile.get(file) || parseFromDisk(file);

  // What a name used in a changed declaration means: a declaration of its
  // own file, or of the file it is imported from. Returns { id, kind, info }
  // (info: for a declaration outside the changes) or null.
  const target = (c, word) => {
    const [head, tail] = word.split('.');
    const own = !tail && c.parsed.decls.find(d => (d.name === head && d.kind !== 'module') || d.names?.has(head));
    if (own) return nodeOfDecl.has(own) ? { id: nodeOfDecl.get(own).id, kind: own.kind } : null;
    const imp = c.parsed.imports.get(head);
    if (!imp) return null;
    const file = resolveImport(imp.spec, c.abs);
    if (!file) return null;
    // Another feature's index.ts: the arrow ends on that feature's facade.
    if (FACADE_FILE.test(file) && featureOf(path.relative(cwd || '', file)) !== c.node.namespace) {
      const facade = parsedOf(file)?.decls.find(d => d.role === 'facade');
      if (facade) return targetOf({ file, decl: facade });
    }
    return targetOf(exportedDecl(file, imp.name === '*' ? tail : imp.name, parsedOf));
  };
  const targetOf = hit => {
    if (!hit) return null;
    const node = nodeOfDecl.get(hit.decl);
    if (node) return { id: node.id, kind: hit.decl.kind };
    const rel = path.relative(cwd || '', hit.file).split(path.sep).join('/');
    return { id: `ctx#${rel}#${hit.decl.name}`, kind: hit.decl.kind, info: { file: hit.file, rel, name: hit.decl.name, kind: hit.decl.kind, role: hit.decl.role || null } };
  };

  const edges = [];
  const contextInfo = new Map();   // context id -> { info, uses }
  const relevantIds = new Set(changed.filter(c => c.node.status !== 'same').map(c => c.node.id));
  for (const c of changed) {
    const d = c.decl;
    const known = name => (c.parsed.imports.get(name)?.name === '*' ? '*' : c.parsed.imports.has(name) || c.parsed.decls.some(o => o !== d && (o.name === name || o.names?.has(name))));
    const words = usedNames(d, c.parsed.sf, known);
    const seen = new Set();
    const link = (word, kind, fresh, line) => {
      const t = typeof word === 'string' ? target(c, word) : word;
      if (!t || t.id === c.node.id || seen.has(t.id)) return;
      seen.add(t.id);
      if (t.info) {
        const ctx = contextInfo.get(t.id) || { info: t.info, uses: 0 };
        if (relevantIds.has(c.node.id)) ctx.uses++;
        contextInfo.set(t.id, ctx);
      }
      edges.push({ from: c.node.id, to: t.id, kind: typeof kind === 'function' ? kind(t.kind) : kind, fresh, line });
    };
    for (const base of d.bases) {
      link(base, k => (k === 'interface' && d.kind === 'class' ? 'implements' : 'inherits'), c.added.has(d.line) && c.node.status !== 'new', d.line);
    }
    // A facade points at what it exports (from its own feature).
    for (const m of d.role === 'facade' ? d.members : []) {
      if (!m.spec) continue;
      const file = resolveImport(m.spec, c.abs);
      const fresh = c.node.status === 'mod' && c.added.has(m.line);
      if (file) link(targetOf(exportedDecl(file, m.exported, parsedOf)), 'uses', fresh, m.line);
    }
    // A system's reads, writes and runs-on first: they say more than "uses".
    const accessOf = word => d.access?.get(word.split('.').pop());
    for (const [word, lines] of [...words].sort((a, b) => (accessOf(b[0]) ? 1 : 0) - (accessOf(a[0]) ? 1 : 0))) {
      // A use is new when it is only on lines the diff added.
      const fresh = c.node.status === 'mod' && [...lines].every(l => c.added.has(l));
      link(word, accessOf(word) || 'uses', fresh, Math.min(...lines));
    }
  }
  // Declarations outside the changes: only the most used ones get a (faded) box.
  const nodes = changed.map(c => c.node);
  const context = [...contextInfo].filter(([, c]) => c.uses > 0).sort((a, b) => b[1].uses - a[1].uses).slice(0, MAX_CONTEXT);
  for (const [id, { info }] of context) {
    nodes.push({ id, name: info.name, kind: info.kind, role: info.role, namespace: featureOf(info.rel), package: null, status: 'context', file: info.file, line: 1, members: [], bases: [] });
  }
  const nodeIds = new Set(nodes.map(n => n.id));
  let kept = edges.filter(e => nodeIds.has(e.to) && e.to !== e.from);
  // Unchanged declarations stay when they are connected to a changed one.
  const touchesChanged = new Set();
  for (const e of kept) {
    if (relevantIds.has(e.from)) touchesChanged.add(e.to);
    if (relevantIds.has(e.to)) touchesChanged.add(e.from);
  }
  const keep = new Set(nodes.filter(n => n.status !== 'same' || touchesChanged.has(n.id)).map(n => n.id));
  kept = kept.filter(e => keep.has(e.from) && keep.has(e.to));
  return {
    nodes: nodes.filter(n => keep.has(n.id)),
    edges: kept.map(({ from, to, kind, fresh, line }) => ({ from, to, kind, fresh, line })),
    testsLeftOut,
  };
}

module.exports = { model, parseFile, isTestFile, TS_FILE };
