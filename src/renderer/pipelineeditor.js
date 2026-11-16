// Settings → Multi-agent: the pipeline's graph as cards you drag and connect
// (see pipeline.js for what the governor does with it), and the agent types
// the cards use.
//
// pipelineEditor(saved) returns { element, value() }: value() is the
// multiAgent setting as it is in the editor now (without `enabled`, which
// the main toggle in settings.js owns).
//
// Profiles: each one is a graph of its own (a Unity task implementer, a Game
// Engine one...); the agent types are shared. The bar on top switches,
// renames, adds and deletes them, and picks the default one, which the ⛓
// Pipeline button under the message box offers first.
//
// The canvas: Your task on the left, Done on the right, the agents between
// them. Drag a card by its title to move it; drag from the dot on a card's
// right side to another card to connect them; click a line to remove it. A
// card that gives a verdict (a reviewer, a tester, Ask the user) also has a
// red ✕ dot at its bottom: drag it back to an earlier card, where the work
// goes when it is not right (a dashed red line under the cards).

const PIPE_NODE_W = 196;
const PIPE_PORT_Y = 21;          // the ports sit at the middle of a card's title bar
const PIPE_TERM_W = 112;
const PIPE_WORLD_W = 6000;
const PIPE_WORLD_H = 4000;

// The last measurement (see the estimate panel), kept while the app runs so
// reopening Settings does not measure again.
let pipeMeasured = null;
let pipeZoom = 1;
// Your skills (slashcommands.js), for the Use a skill cards, per folder.
const pipeSkills = new Map();

function pipelineEditor(saved, { folder = '', folders = [], home = '' } = {}) {
  const P = window.Pipeline;
  const all = P.normalize(saved);
  // The profile on the canvas: cfg is its graph with the shared types.
  let current = all.defaultProfile;
  const profileOf = id => all.profiles.find(p => p.id === id);
  let cfg = { types: all.types, nodes: profileOf(current).nodes, edges: profileOf(current).edges };
  // The canvas's graph back into its profile (cfg is replaced by Start from and Reset).
  const syncProfile = () => {
    const p = profileOf(current);
    if (p) { p.nodes = cfg.nodes; p.edges = cfg.edges; }
    all.types = cfg.types;
  };
  const root = el('div', 'pipe-editor');

  // ---------- profiles ----------
  const profileBar = el('div', 'pipe-profiles');
  const profileSelect = document.createElement('select');
  profileSelect.className = 'pipe-profile-select';
  profileSelect.title = 'The profile on the canvas. ★ is the default one: the ⛓ Pipeline button offers it first';
  const profileName = settingsInput('text', '', { placeholder: 'Profile name', maxLength: 60 });
  profileName.className = 'pipe-profile-name';
  const makeDefault = el('button', 'settings-btn', '★ Make default');
  makeDefault.type = 'button';
  const newProfile = el('button', 'settings-btn', '+ New profile');
  newProfile.type = 'button';
  newProfile.title = 'A copy of this profile, to change. Start from… replaces its cards with a ready-made pipeline';
  const deleteProfile = el('button', 'settings-btn danger-text', 'Delete profile');
  deleteProfile.type = 'button';
  profileBar.append(el('span', 'pipe-profiles-label', 'Profile'), profileSelect, profileName, makeDefault, newProfile, deleteProfile);
  const renderProfiles = () => {
    profileSelect.replaceChildren(...all.profiles.map(p => new Option(`${p.id === all.defaultProfile ? '★ ' : ''}${p.name}`, p.id)));
    profileSelect.value = current;
    profileName.value = profileOf(current).name;
    makeDefault.disabled = current === all.defaultProfile;
    makeDefault.textContent = current === all.defaultProfile ? '★ Default' : '★ Make default';
    makeDefault.title = current === all.defaultProfile ? 'The ⛓ Pipeline button offers this profile first' : 'Make the ⛓ Pipeline button offer this profile first';
    deleteProfile.disabled = all.profiles.length < 2;
  };
  const showProfile = id => {
    syncProfile();
    current = id;
    cfg = { types: all.types, nodes: profileOf(id).nodes, edges: profileOf(id).edges };
    origin = null;
    renderProfiles();
    render();
    renderTypes();
  };
  profileSelect.onchange = () => { window.uiSound?.('tick'); showProfile(profileSelect.value); };
  profileName.oninput = () => {
    profileOf(current).name = profileName.value.trim().slice(0, 60) || 'Pipeline';
    const option = profileSelect.selectedOptions[0];
    if (option) option.textContent = `${current === all.defaultProfile ? '★ ' : ''}${profileOf(current).name}`;
  };
  makeDefault.onclick = () => { all.defaultProfile = current; window.uiSound?.('tick'); renderProfiles(); };
  newProfile.onclick = () => {
    syncProfile();
    const taken = new Set(all.profiles.map(p => p.id));
    let id;
    do id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; while (taken.has(id));
    const from = profileOf(current);
    all.profiles.push({ id, name: `${from.name} (copy)`.slice(0, 60), nodes: JSON.parse(JSON.stringify(cfg.nodes)), edges: JSON.parse(JSON.stringify(cfg.edges)) });
    showProfile(id);
    profileName.focus();
    profileName.select();
  };
  deleteProfile.onclick = () => {
    if (all.profiles.length < 2) return;
    const gone = current;
    all.profiles = all.profiles.filter(p => p.id !== gone);
    if (all.defaultProfile === gone) all.defaultProfile = all.profiles[0].id;
    current = all.defaultProfile;
    window.uiSound?.('tickDown');
    cfg = { types: all.types, nodes: profileOf(current).nodes, edges: profileOf(current).edges };
    origin = null;
    renderProfiles();
    render();
    renderTypes();
  };

  // ---------- toolbar ----------
  const bar = el('div', 'pipe-toolbar');
  const add = document.createElement('select');
  add.className = 'pipe-add';
  const reset = el('button', 'settings-btn', 'Reset to the default pipeline');
  reset.type = 'button';
  // Start from a ready-made graph (pipeline.js TEMPLATES): its cards and
  // connections replace the canvas; the agent types stay as they are.
  const start = document.createElement('select');
  start.className = 'pipe-start';
  start.title = 'Replace the cards with a ready-made pipeline. Your agent types stay as they are';
  start.append(new Option('Start from…', ''), ...window.Pipeline.TEMPLATES.map(t => new Option(t.name, t.id)));
  bar.append(add, start, reset, el('div', 'settings-hint pipe-help',
    'Drag a card by its title to move it. Drag from the dot on its right side to another card to connect them, or to empty space to add a card there; click a line to remove it. Click a card to select it: ⌘/Ctrl+C and V copy and paste it, ⌫ removes it. Ctrl+wheel to zoom, drag the background to move around.'));

  // ---------- canvas ----------
  const scroller = el('div', 'pipe-canvas');
  scroller.tabIndex = 0;
  const sizer = el('div', 'pipe-sizer');
  const surface = el('div', 'pipe-surface');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('pipe-lines');
  surface.appendChild(svg);
  sizer.appendChild(surface);
  scroller.appendChild(sizer);
  // 🧹 in the canvas's top right corner tidies the cards (see tidy below).
  const canvasWrap = el('div', 'pipe-canvas-wrap');
  const tidyBtn = el('button', 'pipe-tidy', '🧹');
  tidyBtn.type = 'button';
  tidyBtn.title = 'Tidy up: line the cards up in evenly spaced columns, in the order they run, with straight connections that do not cross cards';
  canvasWrap.append(scroller, tidyBtn, el('div', 'pipe-canvas-hint', 'Click the canvas to scroll and zoom it'));
  const problems = el('div', 'pipe-problems');

  // ---------- tokens per request ----------
  const estimateBox = el('div', 'pipe-estimate');

  // ---------- agent types ----------
  const typesBox = el('div', 'pipe-types');

  root.append(profileBar, bar, canvasWrap, problems, estimateBox, el('div', 'settings-section-title pipe-types-title', 'Agent types'),
    el('div', 'settings-hint', 'The agents the cards use. Each one is a Claude Code sub-agent with its own instructions, model and tools; the governor gives it its part of the task. Ask the user is the governor itself: it stops and asks you.'),
    typesBox);

  const typeOf = id => cfg.types.find(t => t.id === id);
  const nodeOf = id => cfg.nodes.find(n => n.id === id);
  let selected = null;
  let clipboard = null;
  const select = id => {
    selected = id && nodeOf(id) ? id : null;
    for (const [cid, c] of cards) c.classList.toggle('selected', cid === selected);
  };
  const removeNode = id => {
    cfg.nodes = cfg.nodes.filter(x => x.id !== id);
    cfg.edges = cfg.edges.filter(e => e.from !== id && e.to !== id);
    if (selected === id) selected = null;
    window.uiSound?.('tickDown');
    render();
  };
  const addNode = (type, x, y, extra = {}) => {
    const id = newId('n', new Set(cfg.nodes.map(n => n.id)));
    cfg.nodes.push({ id, type, count: 1, note: '', rounds: 3, ...extra, x: Math.round(x), y: Math.round(y) });
    selected = id;
    window.uiSound?.('tick');
    render();
    requestAnimationFrame(() => cards.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
    return id;
  };
  const fmt = P.formatTokens;
  let estimateNow = P.estimate(cfg, pipeMeasured);

  // What matters most about an agent, as chips: only where it differs from
  // the governor (fewer tools than all, its own model, its own effort),
  // plus whether it gives a verdict, how many run at once and how big each
  // of its requests starts. The same as the governor shows nothing; the
  // table under Tokens per request lists everything.
  const ACCESS = {
    readonly: ['👁 Read only', 'read', 'It can read the code but not change anything'],
    readshell: ['⌘ Read + shell', 'shell', 'It can read and run commands, but has no tools to edit files'],
    edit: ['✎ Edit + shell', 'write', 'It can change files and run commands, with no connectors except the ones listed for it'],
    all: ['✎ Edits files', 'write', 'It has every tool: it can change files and run commands'],
  };
  const modelName = v => (v === 'inherit' ? 'Agent\'s model' : P.MODELS.find(([m]) => m === v)?.[1] || v);
  const chips = (t, count) => {
    const row = el('div', 'pipe-chips');
    if (!t) return row;
    const chip = (text, kind, title) => {
      const c = el('span', `pipe-chip ${kind}`, text);
      if (title) c.title = title;
      row.appendChild(c);
      return c;
    };
    if (t.kind === 'ask') {
      chip('✋ Waits for you', 'ask', 'The governor stops here, shows you where things stand and asks you; the pipeline goes on when you answer');
      return row;
    }
    if (P.byGovernor(t)) {
      chip('🧭 The governor does it', 'gov', 'Not a sub-agent: the governor does this step itself, with its own model, effort, tools and connectors, in the folder');
      return row;
    }
    if (t.tools !== 'all') chip(...ACCESS[t.tools]);
    if (t.tools !== 'all') {
      for (const [name, which] of Object.entries(P.connectorsOf(t))) {
        chip(`🔌 ${name}`, 'mcp', which === 'all' ? `It can use every tool of ${name}` : `It can use ${which} tool${which === 1 ? '' : 's'} of ${name}: ${t.mcp.filter(e => e.includes(':')).map(e => e.split(':')[1]).join(', ')}`);
      }
    }
    if (t.skills?.length) chip(`📘 ${t.skills.length === 1 ? t.skills[0] : `${t.skills.length} skills`}`, 'skill', `Starts with these skills loaded: ${t.skills.join(', ')} (when the project or your setup has them)`);
    if (t.verdict) chip('⚖ Verdict', 'verdict', 'It says whether the work is right: when it is not, the work goes back along its ✕ connection');
    if (t.model !== 'inherit') chip(modelName(t.model), 'model', `Always runs on ${modelName(t.model)}, whatever the pipeline agent runs on`);
    if (t.effort) chip(`${P.EFFORTS.find(([e]) => e === t.effort)?.[1]} effort`, `effort effort-${t.effort}`, 'Thinks this hard, whatever the pipeline agent\'s effort is');
    if (count > 1) chip(`×${count} at once`, 'count', `${count} agents run this step at the same time`);
    const tokens = estimateNow.perType[t.id]?.total;
    if (tokens) chip(`${estimateNow.measured ? '' : '≈'}${fmt(tokens)} / request`, 'tokens', 'The context each of its requests starts with: its instructions, its tools and the instruction files (see Tokens per request below)').dataset.type = t.id;
    return row;
  };
  const accessClass = t => (t?.kind === 'ask' ? 'access-ask' : P.byGovernor(t) ? 'access-gov' : `access-${(ACCESS[t?.tools] || ACCESS.all)[1]}`);

  const newId = (prefix, taken) => { let i = 1; while (taken.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; };

  // Where things are on the surface: Done right of the rightmost card, Your
  // task left of the leftmost one, and room under the cards for the ✕ lines.
  const heightOf = id => cards.get(id)?.offsetHeight || 150;
  let origin = null;
  let frame = false;
  const layout = () => {
    const xs = cfg.nodes.map(n => n.x), ys = cfg.nodes.map(n => n.y);
    const minX = xs.length ? Math.min(...xs) : 200, minY = ys.length ? Math.min(...ys) : 110;
    const maxX = xs.length ? Math.max(...xs) + PIPE_NODE_W : 400;
    const bottom = ys.length ? Math.max(...cfg.nodes.map(n => n.y + heightOf(n.id))) : 230;
    const fails = cfg.edges.filter(P.isFail).length;
    // Your task and Done sit level with the cards they connect to, so those
    // lines are straight; without connections, level with the top row.
    const levelWith = ids => {
      const ys = ids.map(id => nodeOf(id)?.y).filter(y => y != null);
      return (ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : minY) + PIPE_PORT_Y - 22;
    };
    const doneX = maxX + 70;
    return {
      task: { x: minX - PIPE_TERM_W - 70, y: levelWith(cfg.edges.filter(e => e.from === P.TASK).map(e => e.to)) },
      done: { x: doneX, y: levelWith(cfg.edges.filter(e => e.to === P.DONE && !P.isFail(e)).map(e => e.from)) },
      bottom,
      width: doneX + PIPE_TERM_W + 30,
      height: Math.max(bottom + 50 + fails * 16, 300),
    };
  };

  // The agent types as options, the built-in Tactile ones grouped (Tactile,
  // Unity, Game Engine) after the general ones and yours.
  const fillTypes = select => {
    const groups = new Map();
    for (const t of cfg.types) {
      if (!t.group) { select.appendChild(new Option(t.name, t.id)); continue; }
      if (!groups.has(t.group)) groups.set(t.group, Object.assign(document.createElement('optgroup'), { label: t.group }));
      groups.get(t.group).appendChild(new Option(t.name, t.id));
    }
    select.append(...groups.values());
  };

  // ---------- cards ----------
  const cards = new Map();   // node id (and task, done) → element

  const typeSelect = (value, onChange) => {
    const select = document.createElement('select');
    fillTypes(select);
    if (!typeOf(value)) select.appendChild(new Option(`Missing: ${value || 'none'}`, value || ''));
    select.value = value;
    select.onchange = () => onChange(select.value);
    return select;
  };
  const countInput = (value, onChange, title) => {
    const input = settingsInput('number', value, { min: 1, max: 8, step: 1, title });
    input.className = 'pipe-count';
    input.onchange = () => {
      const n = Math.max(1, Math.min(8, Math.round(Number(input.value) || 1)));
      input.value = n;
      onChange(n);
    };
    return input;
  };
  // Your skills, as Claude Code finds them in the folder (yours, the
  // project's and your plugins'), grouped by where they come from.
  const skillSources = { project: 'This project', user: 'Yours', plugin: 'Plugins' };
  const skillFolder = folder || folders[0] || '';
  const loadSkills = () => {
    if (pipeSkills.has(skillFolder) || !window.deck?.slashCommands) return;
    pipeSkills.set(skillFolder, null);
    window.deck.slashCommands(skillFolder).then(list => {
      pipeSkills.set(skillFolder, (list || []).filter(c => c.kind === 'skill'));
      render();
    }).catch(() => pipeSkills.set(skillFolder, []));
  };
  const skillSelect = n => {
    const select = document.createElement('select');
    select.className = 'pipe-skill';
    const skills = pipeSkills.get(skillFolder);
    select.appendChild(new Option(skills ? (skills.length ? 'Pick a skill…' : 'No skills found') : 'Loading skills…', ''));
    for (const [source, label] of Object.entries(skillSources)) {
      const mine = (skills || []).filter(x => x.source === source);
      if (!mine.length) continue;
      const group = Object.assign(document.createElement('optgroup'), { label });
      for (const x of mine) {
        const o = new Option(x.name, x.name);
        o.title = x.description || '';
        group.appendChild(o);
      }
      select.appendChild(group);
    }
    if (n.skill && !(skills || []).some(x => x.name === n.skill)) select.appendChild(new Option(skills ? `${n.skill} (not found here)` : n.skill, n.skill));
    select.value = n.skill || '';
    select.title = (skills || []).find(x => x.name === n.skill)?.description || 'The skill this step runs';
    select.onchange = () => { n.skill = select.value; render(); };
    return select;
  };

  const port = (kind, id) => {
    const p = el('div', `pipe-port pipe-port-${kind}`);
    p.dataset.node = id;
    p.title = kind === 'out' ? 'Drag to another card to send this output there'
      : kind === 'fail' ? 'Not right: drag back to an earlier card, where the work goes when this step says it must change'
        : 'Input';
    return p;
  };

  const nodeCard = n => {
    const card = el('div', 'pipe-node');
    card.dataset.node = n.id;
    const head = el('div', 'pipe-node-head');
    const title = el('span', 'pipe-node-title', typeOf(n.type)?.name || 'Missing type');
    const remove = el('button', 'icon pipe-node-remove', '×');
    remove.type = 'button';
    remove.title = 'Remove this card';
    remove.onclick = () => removeNode(n.id);
    head.append(title, remove);
    card.addEventListener('pointerdown', () => select(n.id));
    card.classList.add(accessClass(typeOf(n.type)));
    const body = el('div', 'pipe-node-body');
    body.appendChild(chips(typeOf(n.type), n.count));
    const t = typeOf(n.type);
    const row = el('div', 'pipe-node-row');
    row.appendChild(typeSelect(n.type, v => {
      n.type = v;
      // A step that no longer gives a verdict loses its ✕ connections.
      if (!typeOf(v)?.verdict) cfg.edges = cfg.edges.filter(e => !(e.from === n.id && P.isFail(e)));
      if (typeOf(v)?.kind === 'ask' || P.byGovernor(typeOf(v))) n.count = 1;
      render();
    }));
    // Asking you, a skill and a custom prompt are the governor itself: never twice at once.
    if (t?.kind !== 'ask' && !P.byGovernor(t)) row.append(el('span', 'pipe-times', '×'), countInput(n.count, v => { n.count = v; render(); }, 'How many agents run this step at the same time'));
    body.appendChild(row);
    // Use a skill: which of your skills; Custom prompt: what the step does.
    if (t?.kind === 'skill') body.appendChild(skillSelect(n));
    if (t?.kind === 'prompt') {
      const text = settingsText(n.prompt, 'What this step does, for example: Write a CHANGELOG entry for the change');
      text.className = 'pipe-prompt';
      text.rows = 3;
      text.oninput = () => { n.prompt = text.value; };
      text.onchange = () => check();
      body.appendChild(text);
    } else {
      const note = settingsInput('text', n.note, { placeholder: t?.kind === 'ask' ? 'What to ask about (optional)' : 'Note for this step (optional)' });
      note.className = 'pipe-note';
      note.oninput = () => { n.note = note.value; };
      body.appendChild(note);
    }
    card.append(port('in', n.id), head, body, port('out', n.id));
    // A verdict: where the work goes when it is not right, and how often.
    if (t?.verdict) {
      const back = el('div', 'pipe-node-fail');
      const rounds = settingsInput('number', n.rounds, { min: 1, max: 10, step: 1, title: 'How many times at most it sends the work back' });
      rounds.className = 'pipe-count';
      rounds.onchange = () => { n.rounds = Math.max(1, Math.min(10, Math.round(Number(rounds.value) || 3))); rounds.value = n.rounds; drawLines(); check(); };
      const target = cfg.edges.find(e => e.from === n.id && P.isFail(e));
      const where = el('span', 'pipe-fail-label', target ? `✕ back to ${typeOf(nodeOf(target.to)?.type)?.name || '?'}` : '✕ drag ● back');
      where.title = target ? 'When it is not right, the work goes back there' : 'Drag the red dot at the bottom of this card to the step the work goes back to when it is not right';
      back.append(where, el('span', 'pipe-fail-max', '≤'), rounds, el('span', 'pipe-fail-max', '×'));
      body.appendChild(back);
      card.appendChild(port('fail', n.id));
    }
    dragCard(card, head, n);
    return card;
  };

  const terminal = (id, label, hint) => {
    const card = el('div', `pipe-term pipe-term-${id}`);
    card.dataset.node = id;
    card.title = hint;
    card.append(el('span', null, label));
    if (id === P.TASK) card.append(port('out', id));
    else card.prepend(port('in', id));
    return card;
  };

  // ---------- moving cards ----------
  const dragCard = (card, handle, n) => {
    handle.onpointerdown = e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
      card.classList.add('dragging');
      handle.onpointermove = m => {
        n.x = Math.min(PIPE_WORLD_W - origin.x - PIPE_NODE_W - PIPE_TERM_W - 110, Math.max(PIPE_TERM_W + 90 - origin.x, Math.round(start.nx + (m.clientX - start.x) / pipeZoom)));
        n.y = Math.min(PIPE_WORLD_H - origin.y - 320, Math.max(80 - origin.y, Math.round(start.ny + (m.clientY - start.y) / pipeZoom)));
        place();
      };
      handle.onpointerup = () => {
        handle.onpointermove = handle.onpointerup = null;
        card.classList.remove('dragging');
      };
    };
  };

  // ---------- connecting ----------
  let pending = null;   // the line being drawn from an output
  const surfacePoint = e => {
    const r = surface.getBoundingClientRect();
    return { x: (e.clientX - r.left) / pipeZoom - origin.x, y: (e.clientY - r.top) / pipeZoom - origin.y };
  };
  surface.addEventListener('pointerdown', e => {
    const out = e.target.closest('.pipe-port-out, .pipe-port-fail');
    if (!out || e.button !== 0) return;
    e.preventDefault();
    const from = out.dataset.node;
    const kind = out.classList.contains('pipe-port-fail') ? 'fail' : '';
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.classList.add('pipe-line', 'pending');
    if (kind) line.classList.add('pipe-fail-line');
    line.setAttribute('transform', `translate(${origin.x},${origin.y})`);
    svg.appendChild(line);
    pending = { from, line };
    surface.classList.add('connecting');
    const move = m => {
      const a = portPoint(from, kind || 'out');
      const b = surfacePoint(m);
      line.setAttribute('d', kind ? `M${a.x},${a.y} C${a.x},${a.y + 60} ${b.x},${b.y + 60} ${b.x},${b.y}` : curve(a, b));
      for (const c of surface.querySelectorAll('.drop-target')) c.classList.remove('drop-target');
      const target = targetAt(m);
      if (target && canConnect(from, target.dataset.node, kind)) target.classList.add('drop-target');
    };
    const up = u => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      surface.classList.remove('connecting');
      for (const c of surface.querySelectorAll('.drop-target')) c.classList.remove('drop-target');
      line.remove();
      pending = null;
      const target = targetAt(u);
      if (target && canConnect(from, target.dataset.node, kind)) {
        // One ✕ connection per card: a new one replaces the old.
        if (kind) cfg.edges = cfg.edges.filter(x => !(x.from === from && P.isFail(x)));
        cfg.edges.push(kind ? { from, to: target.dataset.node, kind } : { from, to: target.dataset.node });
        window.uiSound?.('tick');
        if (kind) render();
        else { drawLines(); check(); }
      } else if (!kind && !document.elementFromPoint(u.clientX, u.clientY)?.closest('.pipe-node, .pipe-term') && scroller.contains(document.elementFromPoint(u.clientX, u.clientY))) {
        const at = surfacePoint(u);
        typeMenu(u, type => {
          const id = addNode(type, at.x, at.y - PIPE_PORT_Y);
          cfg.edges.push({ from, to: id });
          render();
        });
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  const typeMenu = (e, pick) => {
    canvasWrap.querySelector('.pipe-type-menu')?.remove();
    const menu = el('div', 'pipe-type-menu');
    const r = canvasWrap.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX - r.left, r.width - 230)}px`;
    menu.style.top = `${Math.min(e.clientY - r.top, r.height - 40)}px`;
    menu.appendChild(el('div', 'pipe-type-menu-title', 'Add a card'));
    let group = null;
    for (const t of cfg.types) {
      if (t.group !== group) {
        group = t.group;
        if (group) menu.appendChild(el('div', 'pipe-type-menu-group', group));
      }
      const item = el('div', 'group-panel-item', t.name);
      item.onclick = () => { close(); pick(t.id); };
      menu.appendChild(item);
    }
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = ev => { if (!menu.contains(ev.target)) close(); };
    canvasWrap.appendChild(menu);
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    const bottom = menu.getBoundingClientRect().bottom - r.bottom;
    if (bottom > 0) menu.style.top = `${Math.max(0, parseFloat(menu.style.top) - bottom)}px`;
  };
  // The card (or Done) under the pointer: dropping anywhere on a card connects to it.
  const targetAt = e => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const card = hit?.closest('.pipe-node, .pipe-term-done');
    return card && surface.contains(card) ? card : null;
  };
  const canConnect = (from, to, kind = '') => to && from !== to && to !== P.TASK && from !== P.DONE
    && !(kind && to === P.DONE)
    && !cfg.edges.some(e => e.from === from && e.to === to && P.isFail(e) === !!kind);

  // ---------- lines ----------
  const portPoint = (id, kind) => {
    if (id === P.TASK || id === P.DONE) {
      const t = id === P.TASK ? layoutNow.task : layoutNow.done;
      return { x: t.x + (kind === 'out' ? PIPE_TERM_W : 0), y: t.y + 22 };
    }
    const n = nodeOf(id);
    if (kind === 'fail') return { x: n.x + PIPE_NODE_W - 24, y: n.y + heightOf(id) };
    if (kind === 'back') return { x: n.x + PIPE_NODE_W / 2, y: n.y + heightOf(id) + 2 };
    return { x: n.x + (kind === 'out' ? PIPE_NODE_W : 0), y: n.y + PIPE_PORT_Y };
  };
  const curve = (a, b) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  };
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  let layoutNow = null;
  const drawLines = () => {
    svg.replaceChildren();
    const defs = svgEl('defs', {});
    const marker = svgEl('marker', { id: 'pipe-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'pipe-arrowhead' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    const failMarker = svgEl('marker', { id: 'pipe-arrow-fail', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    failMarker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'pipe-arrowhead-fail' }));
    defs.appendChild(failMarker);
    const world = svgEl('g', { transform: `translate(${origin.x},${origin.y})` });
    svg.appendChild(world);
    const edgeGroup = (edge, d, fail) => {
      const g = svgEl('g', { class: `pipe-edge${fail ? ' fail' : ''}` });
      const hit = svgEl('path', { d, class: 'pipe-line-hit' });
      const line = svgEl('path', { d, class: `pipe-line${fail ? ' pipe-fail-line' : ''}`, 'marker-end': `url(#${fail ? 'pipe-arrow-fail' : 'pipe-arrow'})` });
      const tip = svgEl('title', {});
      tip.textContent = fail ? 'Where the work goes when it is not right. Click to remove' : 'Click to remove this connection';
      g.append(hit, line, tip);
      g.onclick = () => {
        cfg.edges = cfg.edges.filter(e => e !== edge);
        window.uiSound?.('tickDown');
        if (fail) render();
        else { drawLines(); check(); }
      };
      world.appendChild(g);
      return g;
    };
    // A connection that would run through a card on its way (one that skips
    // a column, say) goes over the cards instead, each in its own lane.
    let lane = 0;
    const inSpan = (x1, x2) => cfg.nodes.filter(n => n.x < Math.max(x1, x2) + 20 && n.x + PIPE_NODE_W > Math.min(x1, x2) - 20);
    const crosses = (d, skip) => {
      const rects = cfg.nodes.filter(n => !skip.includes(n.id)).map(n => ({ l: n.x - 6, r: n.x + PIPE_NODE_W + 6, t: n.y - 6, b: n.y + heightOf(n.id) + 6 }));
      if (!rects.length) return false;
      const probe = svgEl('path', { d });
      svg.appendChild(probe);
      const len = probe.getTotalLength();
      const steps = Math.ceil(len / 10);
      let hit = false;
      for (let i = 0; i <= steps && !hit; i++) {
        const q = probe.getPointAtLength(len * i / steps);
        hit = rects.some(r => q.x > r.l && q.x < r.r && q.y > r.t && q.y < r.b);
      }
      probe.remove();
      return hit;
    };
    for (const edge of cfg.edges.filter(e => !P.isFail(e))) {
      const a = portPoint(edge.from, 'out');
      const b = portPoint(edge.to, 'in');
      const d = curve(a, b);
      if (b.x <= a.x || !crosses(d, [edge.from, edge.to])) { edgeGroup(edge, d, false); continue; }
      const over = inSpan(a.x, b.x);
      const y = (over.length ? Math.min(...over.map(n => n.y)) : a.y) - 26 - lane++ * 14;
      const r = 14;
      edgeGroup(edge, `M${a.x},${a.y} C${a.x + 24},${a.y} ${a.x + 24},${y} ${a.x + 24 + r},${y} L${b.x - 24 - r},${y} C${b.x - 24},${y} ${b.x - 24},${b.y} ${b.x},${b.y}`, false);
    }
    // "Not right": out of the red dot at the card's bottom, along a lane
    // under the cards, and up into the bottom of the card it goes back to.
    cfg.edges.filter(P.isFail).forEach((edge, i) => {
      const from = portPoint(edge.from, 'fail');
      const to = portPoint(edge.to, 'back');
      const r = 14;
      const dir = to.x < from.x ? -1 : 1;
      // A card under the dot (a column of several): go down the gap right
      // of the column instead of through it.
      const gate = nodeOf(edge.from);
      const under = cfg.nodes.some(n => n.id !== gate.id && n.y > gate.y && n.x < from.x + 8 && n.x + PIPE_NODE_W > from.x - 8);
      const gx = gate.x + PIPE_NODE_W + 30 + i * 6;
      const xs = under ? [from.x, to.x, gx] : [from.x, to.x];
      const low = Math.max(...inSpan(Math.min(...xs), Math.max(...xs)).map(n => n.y + heightOf(n.id))) + 26 + i * 16;
      const d = under
        ? (() => {
          const y1 = from.y + 18;
          return `M${from.x},${from.y + 7} L${from.x},${y1 - r} Q${from.x},${y1} ${from.x + r},${y1} L${gx - r},${y1} Q${gx},${y1} ${gx},${y1 + r} L${gx},${low - r} Q${gx},${low} ${gx - r},${low} L${to.x - dir * r},${low} Q${to.x},${low} ${to.x},${low - r} L${to.x},${to.y}`;
        })()
        : `M${from.x},${from.y + 7} L${from.x},${low - r} Q${from.x},${low} ${from.x + dir * r},${low} L${to.x - dir * r},${low} Q${to.x},${low} ${to.x},${low - r} L${to.x},${to.y}`;
      const g = edgeGroup(edge, d, true);
      const label = svgEl('text', { x: (from.x + to.x) / 2, y: low - 5, class: 'pipe-fail-caption', 'text-anchor': 'middle' });
      label.textContent = `✕ not right → back to ${typeOf(nodeOf(edge.to)?.type)?.name || edge.to} (up to ${gate.rounds}×)`;
      g.appendChild(label);
    });
  };

  // Moves everything to where layout() says, then redraws the lines.
  const bounds = () => {
    const { task, done, height } = layoutNow;
    const top = Math.min(task.y, done.y, ...cfg.nodes.map(n => n.y)) - 60;
    return { left: task.x, right: done.x + PIPE_TERM_W, top, bottom: height };
  };
  const place = () => {
    layoutNow = layout();
    const { task, done, height } = layoutNow;
    if (!origin) {
      const b = bounds();
      origin = { x: Math.round(PIPE_WORLD_W / 2 - (b.left + b.right) / 2), y: Math.round(PIPE_WORLD_H / 2 - (b.top + b.bottom) / 2) };
      frame = true;
    }
    surface.style.width = `${PIPE_WORLD_W}px`;
    surface.style.height = `${PIPE_WORLD_H}px`;
    surface.style.transform = `scale(${pipeZoom})`;
    sizer.style.width = `${Math.ceil(PIPE_WORLD_W * pipeZoom)}px`;
    sizer.style.height = `${Math.ceil(PIPE_WORLD_H * pipeZoom)}px`;
    scroller.style.height = `${height}px`;
    svg.setAttribute('width', PIPE_WORLD_W);
    svg.setAttribute('height', PIPE_WORLD_H);
    for (const [id, card] of cards) {
      const at = id === P.TASK ? task : id === P.DONE ? done : nodeOf(id);
      card.style.left = `${at.x + origin.x}px`;
      card.style.top = `${at.y + origin.y}px`;
    }
    drawLines();
  };
  const showGraph = smooth => {
    const b = bounds();
    const w = (b.right - b.left) * pipeZoom, h = (b.bottom - b.top) * pipeZoom;
    const left = (b.left + origin.x) * pipeZoom, top = (b.top + origin.y) * pipeZoom;
    scroller.scrollTo({
      left: w > scroller.clientWidth - 32 ? left - 16 : left - (scroller.clientWidth - w) / 2,
      top: h > scroller.clientHeight - 32 ? top - 16 : top - (scroller.clientHeight - h) / 2,
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  // ---------- zoom and moving around ----------
  const isBackground = e => e.target === surface || e.target === sizer || e.target === scroller;
  const zoomAt = (factor, clientX, clientY) => {
    const k = Math.min(2, Math.max(0.25, pipeZoom * factor));
    if (k === pipeZoom) return;
    const r = scroller.getBoundingClientRect();
    const vx = clientX - r.left, vy = clientY - r.top;
    const cx = (scroller.scrollLeft + vx) / pipeZoom, cy = (scroller.scrollTop + vy) / pipeZoom;
    pipeZoom = k;
    place();
    scroller.scrollLeft = cx * k - vx;
    scroller.scrollTop = cy * k - vy;
  };
  scroller.addEventListener('pointerdown', () => {
    if (!scroller.contains(document.activeElement)) scroller.focus({ preventScroll: true });
  }, true);
  scroller.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });
  scroller.addEventListener('dblclick', e => {
    if (isBackground(e)) zoomAt(1 / pipeZoom, e.clientX, e.clientY);
  });
  scroller.addEventListener('keydown', e => {
    if (e.target !== scroller) return;
    const mod = e.metaKey || e.ctrlKey;
    const node = selected && nodeOf(selected);
    if (mod && e.key.toLowerCase() === 'c' && node) {
      clipboard = { ...node };
      e.preventDefault();
    } else if (mod && e.key.toLowerCase() === 'v' && clipboard) {
      const { id, x, y, ...rest } = clipboard;
      clipboard = { ...clipboard, x: x + 40, y: y + 40 };
      addNode(rest.type, x + 40, y + 40, rest);
      e.preventDefault();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && node) {
      removeNode(node.id);
      e.preventDefault();
    }
  });
  scroller.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !isBackground(e)) return;
    select(null);
    scroller.setPointerCapture(e.pointerId);
    scroller.classList.add('panning');
    const start = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    const move = m => {
      scroller.scrollLeft = start.left - (m.clientX - start.x);
      scroller.scrollTop = start.top - (m.clientY - start.y);
    };
    const up = () => {
      scroller.removeEventListener('pointermove', move);
      scroller.removeEventListener('pointerup', up);
      scroller.classList.remove('panning');
    };
    scroller.addEventListener('pointermove', move);
    scroller.addEventListener('pointerup', up);
  });

  // ---------- problems ----------
  const check = () => {
    renderEstimate();
    const found = P.validate(cfg);
    for (const [id, card] of cards) {
      const mine = found.filter(p => p.node === id);
      card.classList.toggle('pipe-error', mine.some(p => p.level === 'error'));
      card.classList.toggle('pipe-warning', !mine.some(p => p.level === 'error') && mine.some(p => p.level === 'warning'));
      card.querySelector('.pipe-badge')?.remove();
      const serious = mine.filter(p => p.level !== 'info');
      if (serious.length) {
        const badge = el('span', 'pipe-badge', '!');
        badge.title = serious.map(p => p.text).join('\n');
        card.appendChild(badge);
      }
    }
    problems.replaceChildren();
    if (!found.length) {
      problems.appendChild(el('div', 'pipe-problem ok', '✓ The pipeline is connected: every agent gets an input and its output is used.'));
      return;
    }
    for (const p of found) {
      const row = el('div', `pipe-problem ${p.level}`, `${p.level === 'error' ? '✕' : p.level === 'warning' ? '⚠' : 'ℹ'} ${p.text}`);
      if (p.node && cards.has(p.node)) {
        row.classList.add('linked');
        row.title = 'Show it';
        row.onclick = () => {
          const card = cards.get(p.node);
          card.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
          card.classList.remove('flash');
          void card.offsetWidth;
          card.classList.add('flash');
        };
      }
      problems.appendChild(row);
    }
  };

  // ---------- tidying up ----------
  // Columns by the longest way from Your task over the normal connections,
  // so every card sits right of everything that feeds it (Ask the user
  // between the analyst and the planner gets its own column between
  // theirs). Within a column, cards are ordered by where the cards feeding
  // them are (fewer crossings) and stacked around one middle line, so a
  // single row is perfectly straight. Cards only reached by going back, or
  // not at all, go in a row underneath.
  const TIDY_GAP_X = 64;
  const TIDY_GAP_Y = 40;
  const TIDY_X = PIPE_TERM_W + 100;
  const TIDY_Y = 120;
  const tidyTargets = () => {
    const normal = cfg.edges.filter(e => !P.isFail(e));
    const depth = new Map();
    // Longest path (the normal connections have no circles once valid; a
    // circle stops after as many passes as there are cards).
    for (const n of cfg.nodes) if (normal.some(e => e.from === P.TASK && e.to === n.id)) depth.set(n.id, 0);
    for (let pass = 0; pass < cfg.nodes.length; pass++) {
      let moved = false;
      for (const e of normal) {
        if (e.from === P.TASK || e.to === P.DONE || !depth.has(e.from)) continue;
        const d = depth.get(e.from) + 1;
        if (!depth.has(e.to) || depth.get(e.to) < d) { depth.set(e.to, d); moved = true; }
      }
      if (!moved) break;
    }
    const columns = [];
    for (const [id, d] of depth) (columns[d] = columns[d] || []).push(id);
    const placed = new Map();
    const order = new Map();
    let x = TIDY_X;
    for (const column of columns.filter(Boolean)) {
      const fed = id => {
        const from = normal.filter(e => e.to === id && order.has(e.from)).map(e => order.get(e.from));
        return from.length ? from.reduce((a, b) => a + b, 0) / from.length : nodeOf(id).y / 1000;
      };
      column.sort((a, b) => fed(a) - fed(b) || nodeOf(a).y - nodeOf(b).y);
      column.forEach((id, i) => order.set(id, i));
      const total = column.reduce((sum, id) => sum + heightOf(id), 0) + (column.length - 1) * TIDY_GAP_Y;
      // One card: its top on the row, so ports (a fixed distance below a
      // card's top) line up. Several: stacked around the row's middle.
      let y = column.length === 1 ? TIDY_Y : TIDY_Y + heightOf(column[0]) / 2 - total / 2;
      for (const id of column) { placed.set(id, { x, y }); y += heightOf(id) + TIDY_GAP_Y; }
      x += PIPE_NODE_W + TIDY_GAP_X;
    }
    // The rest: a row under everything.
    const rest = cfg.nodes.filter(n => !placed.has(n.id)).sort((a, b) => a.x - b.x);
    if (rest.length) {
      const below = Math.max(...[...placed].map(([id, p]) => p.y + heightOf(id)), TIDY_Y) + 90 + cfg.edges.filter(P.isFail).length * 16;
      rest.forEach((n, i) => placed.set(n.id, { x: TIDY_X + i * (PIPE_NODE_W + TIDY_GAP_X), y: below }));
    }
    // Room above the top row for connections that go over the cards.
    const topY = Math.min(...[...placed.values()].map(p => p.y));
    const lanes = normal.filter(e => e.from !== P.TASK && e.to !== P.DONE && (depth.get(e.to) ?? 0) - (depth.get(e.from) ?? 0) > 1).length;
    const shift = Math.max(0, 90 + lanes * 14 - topY);
    if (shift) for (const p of placed.values()) p.y += shift;
    return placed;
  };
  const tidy = () => {
    const targets = tidyTargets();
    const from = new Map(cfg.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
    const moveTo = at => { for (const n of cfg.nodes) { const p = at.get(n.id); if (p) { n.x = p.x; n.y = p.y; } } };
    moveTo(targets);
    layoutNow = layout();
    const end = bounds();
    scroller.style.height = `${layoutNow.height}px`;
    moveTo(from);
    const zoomFrom = pipeZoom;
    const zoomTo = Math.min(1, Math.max(0.25, Math.min((scroller.clientWidth - 32) / (end.right - end.left), (scroller.clientHeight - 32) / (end.bottom - end.top))));
    const start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    window.uiSound?.('tick');
    const step = now => {
      const t = Math.min(1, (now - start) / 320);
      for (const n of cfg.nodes) {
        const a = from.get(n.id), b = targets.get(n.id);
        if (!b) continue;
        n.x = Math.round(a.x + (b.x - a.x) * ease(t));
        n.y = Math.round(a.y + (b.y - a.y) * ease(t));
      }
      pipeZoom = zoomFrom + (zoomTo - zoomFrom) * ease(t);
      place();
      showGraph(false);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  tidyBtn.onclick = tidy;

  // ---------- the whole canvas ----------
  const render = () => {
    for (const c of surface.querySelectorAll('.pipe-node, .pipe-term')) c.remove();
    cards.clear();
    cards.set(P.TASK, terminal(P.TASK, '✉ Your task', 'Your message to the agent'));
    cards.set(P.DONE, terminal(P.DONE, '✓ Done', 'What reaches Done is the result of the pipeline'));
    for (const n of cfg.nodes) cards.set(n.id, nodeCard(n));
    for (const [, card] of cards) surface.appendChild(card);
    select(selected);
    place();
    // Card heights are known once they are on screen: the ✕ lines need them.
    requestAnimationFrame(place);
    if (frame) {
      frame = false;
      requestAnimationFrame(() => showGraph(false));
    }
    check();
    fillAdd();
  };

  // ---------- adding cards ----------
  const fillAdd = () => {
    add.replaceChildren(new Option('+ Agent…', ''));
    fillTypes(add);
    add.value = '';
  };
  add.onchange = () => {
    const type = add.value;
    if (!type) return;
    // Right of the rightmost card, or under it when the row is long.
    const right = cfg.nodes.reduce((m, n) => (n.x > m.x ? n : m), { x: 0, y: 110 });
    const x = right.x ? right.x + PIPE_NODE_W + 34 : 200;
    if (x > 1300) addNode(type, 200, right.y + 200);
    else addNode(type, x, right.y);
  };
  start.onchange = () => {
    const id = start.value;
    start.value = '';
    if (!id) return;
    cfg = { ...cfg, ...P.template(id) };
    origin = null;
    window.uiSound?.('tick');
    render();
    renderTypes();
  };
  reset.onclick = () => {
    // The types as they came, and this profile's graph as the General one.
    cfg = { types: P.defaults().types, ...P.template('default') };
    origin = null;
    window.uiSound?.('tick');
    render();
    renderTypes();
  };

  // ---------- agent types ----------
  const renderTypes = (openId = null) => {
    typesBox.replaceChildren();
    for (const t of cfg.types) {
      const item = document.createElement('details');
      item.className = 'pipe-type';
      if (t.id === openId) item.open = true;
      const sum = document.createElement('summary');
      const used = cfg.nodes.filter(n => n.type === t.id).length;
      sum.append(el('span', 'pipe-type-name', t.name),
        chips(t, 1),
        el('span', 'pipe-type-meta', [t.builtin ? 'built in' : 'yours', used ? `used ${used}×` : 'not used'].join(' · ')),
        el('span', 'pipe-type-desc', t.description));
      item.appendChild(sum);

      const name = settingsInput('text', t.name);
      name.oninput = () => { t.name = name.value || t.id; sum.querySelector('.pipe-type-name').textContent = t.name; };
      name.onchange = () => render();
      const desc = settingsInput('text', t.description, { placeholder: 'What it does, in one sentence' });
      desc.oninput = () => { t.description = desc.value; sum.querySelector('.pipe-type-desc').textContent = t.description; };
      const model = settingsSelect(P.MODELS, t.model);
      model.onchange = () => { t.model = model.value; renderTypes(t.id); render(); };
      const effort = settingsSelect(P.EFFORTS, t.effort || '');
      effort.onchange = () => { t.effort = effort.value; renderTypes(t.id); render(); };
      const tools = settingsSelect(Object.entries(P.TOOL_NAMES), t.tools);
      tools.onchange = () => { t.tools = tools.value; renderTypes(t.id); render(); };
      // Connectors (MCP) on top of the tool set, and skills it starts with.
      const listText = list => (list || []).join(', ');
      const mcp = settingsText((t.mcp || []).join('\n'), `One per line: a connector (${Object.keys(P.CONNECTORS).join(', ')}), a connector and one of its tools (tactile-pm:pm_get_task), or a full tool name (mcp__server__tool)`);
      mcp.rows = Math.min(8, Math.max(2, (t.mcp || []).length + 1));
      mcp.disabled = t.tools === 'all';
      mcp.onchange = () => { t.mcp = P.cleanMcp(mcp.value); renderTypes(t.id); render(); };
      const skills = settingsInput('text', listText(t.skills), { placeholder: 'Skill names, separated by commas' });
      skills.onchange = () => { t.skills = P.cleanSkills(skills.value); renderTypes(t.id); render(); };
      // Your own types: a sub-agent or a stop to ask you, and whether it
      // gives a verdict (a ✕ "not right" output on its cards).
      const kind = settingsSelect([['agent', 'A sub-agent'], ['ask', 'Ask the user (the governor stops)']], t.kind || 'agent');
      kind.onchange = () => { t.kind = kind.value; if (t.kind === 'ask') t.verdict = true; renderTypes(t.id); render(); };
      const verdict = settingsInput('checkbox', t.verdict);
      verdict.onchange = () => {
        t.verdict = verdict.checked;
        if (!t.verdict) cfg.edges = cfg.edges.filter(e => !(P.isFail(e) && nodeOf(e.from)?.type === t.id));
        renderTypes(t.id);
        render();
      };
      const prompt = settingsText(t.prompt, t.kind === 'ask' ? 'What the governor shows you and asks before it goes on' : 'Its instructions: what it does, what it must not do, and what its answer contains');
      prompt.rows = 6;
      prompt.oninput = () => { t.prompt = prompt.value; renderEstimate(); };

      const actions = el('div', 'pipe-type-actions');
      if (t.builtin) {
        const restore = el('button', 'settings-btn', 'Restore its instructions');
        restore.type = 'button';
        restore.onclick = () => {
          const original = P.BUILTIN_TYPES.find(b => b.id === t.id);
          Object.assign(t, original, { builtin: true });
          renderTypes(t.id);
          render();
        };
        actions.appendChild(restore);
      } else {
        const del = el('button', 'settings-btn danger-text', 'Delete this type');
        del.type = 'button';
        del.title = used ? 'Cards that use it show a problem until you pick another type' : '';
        del.onclick = () => {
          cfg.types = cfg.types.filter(x => x !== t);
          window.uiSound?.('tickDown');
          renderTypes();
          render();
        };
        actions.appendChild(del);
      }
      const ask = t.kind === 'ask';
      const own = ask || P.byGovernor(t);
      item.append(
        settingsField('Name', null, name),
        settingsField('Description', 'The governor reads this to know what the agent is for', desc),
        ...(t.builtin ? [] : [settingsField('Kind', 'Ask the user: the governor stops, shows you where things stand and waits for your answer or approval', kind)]),
        ...(own ? [] : [
          settingsField('Model', 'Same as the agent: the model the pipeline agent runs on', model),
          settingsField('Effort', 'How hard it thinks. Higher: better on hard steps (planning, review), slower and more tokens', effort),
          settingsField('Tools', 'Read only: it can look but not change files. Read + shell: it can run commands too. Edit + shell: it can change files, with only the connectors below. All tools: everything the pipeline agent has, every connector included', tools),
          settingsField('Connectors', t.tools === 'all'
            ? 'It has every tool, so it gets every connector. Pick another tool set to give it only some'
            : 'The MCP tools it may use on top of its tool set; nothing else. Names a connector does not have are ignored', mcp),
          settingsField('Skills', 'Loaded into it when it starts, if the project or your setup has a skill of that name (for example unity-cli, testing)', skills),
          ...(t.builtin ? [] : [settingsField('Gives a verdict', 'Its cards get a ✕ "not right" output that sends the work back to an earlier step. It ends its answer with a verdict (approve or changes) that Agent Hub reads', verdict)]),
        ]),
        settingsField(ask ? 'What it shows and asks' : own ? 'What the governor does for it' : 'Instructions', own && !ask ? 'Not a sub-agent: the governor does these steps itself, on its own model, effort and tools. This is added to what the card says' : null, prompt),
        actions);
      typesBox.appendChild(item);
    }
    const create = el('button', 'settings-btn pipe-type-new', '+ New agent type');
    create.type = 'button';
    create.onclick = () => {
      const id = newId('custom-', new Set(cfg.types.map(t => t.id)));
      cfg.types.push({ id, name: 'New agent', description: '', prompt: '', model: 'inherit', tools: 'all', mcp: [], skills: [], effort: '', kind: 'agent', verdict: false, builtin: false });
      window.uiSound?.('tick');
      renderTypes(id);
      render();
      requestAnimationFrame(() => typesBox.querySelector('details[open] input')?.focus());
    };
    typesBox.appendChild(create);
  };

  // ---------- the estimate panel ----------
  // Measured: Claude Code, started as the governor would be in the folder,
  // reports its context (agents.js measurePipeline). The instruction files
  // it found (CLAUDE.md, AGENTS.md, rules, the global ones) are what every
  // agent of the pipeline reads, sub-agents too.
  const shortFolder = f => (home && f && (f === home || f.startsWith(home + '/') || f.startsWith(home + '\\')) ? '~' + f.slice(home.length) : f);
  const folderSelect = document.createElement('select');
  folderSelect.className = 'pipe-folder';
  let measureFolder = pipeMeasured?.folder || folder || folders[0] || '';
  const fillFolders = () => {
    folderSelect.replaceChildren();
    for (const f of [...new Set([measureFolder, ...folders].filter(Boolean))]) folderSelect.appendChild(new Option(`📁 ${shortFolder(f)}`, f));
    folderSelect.appendChild(new Option('Choose folder…', '__choose'));
    folderSelect.value = measureFolder || '__choose';
  };
  fillFolders();
  const measureBtn = el('button', 'settings-btn', 'Measure');
  measureBtn.type = 'button';
  let measuring = false;
  let measureNote = '';
  const measure = async () => {
    if (measuring || !window.deck?.measurePipeline) return;
    if (!measureFolder) { measureNote = 'Pick the folder your agents work in.'; renderEstimate(); return; }
    measuring = true;
    measureNote = '';
    renderEstimate();
    const result = await window.deck.measurePipeline(P.normalize(cfg), measureFolder).catch(err => ({ error: String(err?.message || err) }));
    measuring = false;
    if (result?.error) measureNote = result.error;
    else { pipeMeasured = { ...result, prompt: P.governorPrompt(cfg) }; }
    render();
  };
  measureBtn.onclick = measure;
  folderSelect.onchange = async () => {
    if (folderSelect.value === '__choose') {
      const chosen = await window.deck?.pickFolder?.();
      if (chosen) measureFolder = chosen;
      fillFolders();
      if (!chosen) return;
    } else measureFolder = folderSelect.value;
    measure();
  };

  let costHistory = { id: null, list: null };
  const median = xs => { const a = xs.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
  const money = v => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
  const times = v => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;
  const CATEGORY_NAMES = { system_prompt: 'System prompt + pipeline instructions', system_tools: 'Tools', memory_files: 'Instruction files', skills: 'Skills', custom_agents: 'Pipeline agents list', mcp_tools: 'MCP tools', messages: 'Message', slash_commands: 'Commands' };
  const stat = (label, value, hint, kind = '') => {
    const tile = el('div', `pipe-stat ${kind}`);
    tile.append(el('div', 'pipe-stat-value', value), el('div', 'pipe-stat-label', label));
    if (hint) tile.title = hint;
    return tile;
  };
  const renderEstimate = () => {
    estimateNow = P.estimate(cfg, pipeMeasured);
    for (const c of root.querySelectorAll('.pipe-chip.tokens')) {
      const total = estimateNow.perType[c.dataset.type]?.total;
      if (total) c.textContent = `${estimateNow.measured ? '' : '≈'}${fmt(total)} / request`;
    }
    const e = estimateNow;
    const m = pipeMeasured;
    estimateBox.replaceChildren();
    const head = el('div', 'pipe-estimate-head');
    head.append(el('div', 'settings-section-title', 'Tokens per request'), folderSelect, measureBtn);
    measureBtn.disabled = measuring;
    measureBtn.textContent = measuring ? 'Measuring…' : m ? 'Measure again' : 'Measure';
    const status = el('div', 'settings-hint pipe-estimate-status');
    if (measuring) status.textContent = 'Starting Claude Code in the folder to read what it loads (no message is sent, so it costs nothing)…';
    else if (measureNote) { status.textContent = measureNote; status.classList.add('danger-text'); }
    else if (m) {
      const changed = m.prompt !== P.governorPrompt(cfg);
      status.textContent = `Measured in ${shortFolder(m.folder)} at ${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${m.governor.model ? `, on ${m.governor.model}` : ''}.`
        + (changed ? ' The graph changed since: the governor\'s number is from before, Measure again for the exact one.' : '');
    } else status.textContent = 'Rough defaults. Measure reads what Claude Code loads in the folder: CLAUDE.md, AGENTS.md, rules, skills and MCP tools.';
    head.appendChild(status);
    estimateBox.appendChild(head);

    const sub = Object.entries(e.perType).filter(([id]) => typeOf(id)?.kind !== 'ask' && !P.byGovernor(typeOf(id)) && cfg.nodes.some(n => n.type === id));
    const biggest = sub.reduce((max, [, v]) => Math.max(max, v.total), 0);
    const tiles = el('div', 'pipe-stats');
    const approx = e.measured ? '' : '≈';
    tiles.append(
      stat('Governor, each request', approx + fmt(e.governor), 'The context the governor sends with every request before any work: Claude Code\'s and Agent Hub\'s instructions, the pipeline\'s, its tools and the instruction files', 'main'),
      stat('Largest sub-agent, each request', approx + fmt(biggest), 'Its instructions, its tools and the instruction files; the inputs the governor gives it come on top'),
      stat(`Whole run, first time through (${e.agents + 1} agents${e.asks ? `, stops to ask you ${e.asks}×` : ''})`, approx + fmt(e.oneRound), 'Every agent\'s first request added up: the governor and each step × its count'),
      stat(e.rounds > 1 ? 'Whole run, sent back every time' : 'Whole run, nothing sent back', approx + fmt(e.worst), 'When every ✕ "not right" is taken as often as it may be: the steps from the one it goes back to, up to the one that sends it back, run again', e.rounds > 1 ? 'warn' : ''));
    estimateBox.appendChild(tiles);

    if (costHistory.id !== current) {
      costHistory = { id: current, list: null };
      window.deck?.pipelineCosts?.(current).then(list => {
        if (costHistory.id !== current) return;
        costHistory.list = Array.isArray(list) ? list : [];
        renderEstimate();
      }).catch(() => { costHistory.list = []; });
    }
    const one = P.oneCall(cfg, m);
    const runs = costHistory.list || [];
    const medTokens = median(runs.map(r => r.tokens));
    const medUsd = median(runs.map(r => r.usd));
    const medWeek = median(runs.map(r => r.weekPct));
    const compare = el('div', 'pipe-stats');
    compare.append(
      stat('One plain Opus call, this folder', `${one.measured ? '' : '≈'}${fmt(one.tokens)} · ${money(one.usd)}`, 'The same request to a plain agent instead of the pipeline: one request with the agent\'s context (the governor\'s without the pipeline\'s instructions and its agents list) and an answer of about 1.5k tokens, at API list prices (Opus: $4 per million in, $20 per million out). A plain agent that uses tools makes more requests than one.'),
      stat('A run, at the very least', `≥ ${times(e.oneRound / one.tokens)}`, 'Whole run, first time through ÷ one plain call: one request per agent and nothing sent back. A real run makes many requests per agent, each carrying its conversation so far, so expect far more', 'warn'));
    if (runs.length) {
      const n = runs.length;
      const range = `${fmt(Math.min(...runs.map(r => r.tokens)))} to ${fmt(Math.max(...runs.map(r => r.tokens)))} tokens, ${money(Math.min(...runs.map(r => r.usd)))} to ${money(Math.max(...runs.map(r => r.usd)))}`;
      compare.append(stat(`Measured: ${n} past run${n === 1 ? '' : 's'} of this profile`, `${fmt(medTokens)} · ${money(medUsd)} ≈ ${times(medUsd > 0 && one.usd > 0 ? medUsd / one.usd : medTokens / one.tokens)}`, `The typical (median) run of this profile, sub-agents included, next to one plain Opus call. Runs: ${range}${runs.some(r => r.failed) ? `; ${runs.filter(r => r.failed).length} failed` : ''}`, 'main'));
      if (medWeek != null) compare.append(stat('Of your week, typical run', medWeek < 0.05 ? '<0.1%' : `${medWeek >= 10 ? medWeek.toFixed(0) : medWeek.toFixed(1)}%`, 'From the usage windows Claude Code reports at the start and the end of each run'));
    }
    estimateBox.append(el('div', 'pipe-estimate-sub pipe-compare', 'Whole run vs one plain Opus call'), compare);
    if (!runs.length) estimateBox.appendChild(el('div', 'settings-hint', costHistory.list ? 'No finished run of this profile yet: after one, what it took shows here, and under the pipeline graph in its chat.' : 'Looking up past runs…'));

    // The governor's context, by part, as a bar.
    if (m) {
      const parts = m.governor.categories.filter(c => c.tokens > 0 && c.id !== 'messages');
      const sum = parts.reduce((s2, c) => s2 + c.tokens, 0) || 1;
      const barEl = el('div', 'pipe-bar');
      const legend = el('div', 'pipe-legend');
      parts.forEach((c, i) => {
        const seg = el('div', `pipe-seg seg-${i % 6}`);
        seg.style.width = `${(c.tokens / sum) * 100}%`;
        seg.title = `${CATEGORY_NAMES[c.id] || c.name}: ${fmt(c.tokens)}`;
        barEl.appendChild(seg);
        const item = el('span', 'pipe-legend-item');
        item.append(el('span', `pipe-dot seg-${i % 6}`), `${CATEGORY_NAMES[c.id] || c.name} ${fmt(c.tokens)}`);
        legend.appendChild(item);
      });
      estimateBox.append(el('div', 'pipe-estimate-sub', 'The governor\'s context'), barEl, legend);
    }

    // The instruction files every agent reads.
    const files = el('div', 'pipe-files');
    files.appendChild(el('div', 'pipe-estimate-sub', 'Instruction files every agent reads'));
    if (!m) files.appendChild(el('div', 'settings-hint', 'Measure to find them (CLAUDE.md, CLAUDE.local.md, .claude/rules, and AGENTS.md in a project without CLAUDE.md, in the folder and the folders above it, plus your global ones).'));
    else if (!m.governor.memoryFiles.length) files.appendChild(el('div', 'settings-hint', 'None: there is no CLAUDE.md or AGENTS.md in this folder, the folders above it, or your global settings.'));
    else {
      for (const f of [...m.governor.memoryFiles].sort((a, b) => b.tokens - a.tokens)) {
        const row = el('div', 'pipe-file');
        const shown = shortFolder(f.path);
        const name = el('span', 'pipe-file-name', shown.length > 90 ? `…${shown.slice(-89)}` : shown);
        name.title = f.path;
        row.append(name, el('span', 'pipe-file-type', f.type || ''), el('span', 'pipe-file-tokens', fmt(f.tokens)));
        if (f.tokens > 5000) { row.classList.add('big'); row.title = 'A big file: every request of every agent carries it'; }
        files.appendChild(row);
      }
    }
    if (m?.governor.mcpTools.length) files.appendChild(el('div', 'settings-hint', `MCP tools: ${m.governor.mcpTools.length} (${fmt(m.governor.mcp)}). Sub-agents with every tool get them too.`));
    if (m?.governor.deferred) files.appendChild(el('div', 'settings-hint', `Not counted: ${fmt(m.governor.deferred)} of tools that load only when an agent looks for them.`));
    estimateBox.appendChild(files);

    // Per agent type the graph uses.
    const table = el('div', 'pipe-table');
    const header = el('div', 'pipe-row pipe-row-head');
    for (const h of ['Agent', 'Runs', 'Can', 'Model', 'Effort', 'Instructions', 'Tools', 'Files', 'Each request']) header.appendChild(el('span', null, h));
    table.appendChild(header);
    for (const [id, v] of sub) {
      const t = typeOf(id);
      const runs = cfg.nodes.filter(n => n.type === id).reduce((s2, n) => s2 + n.count, 0);
      const row = el('div', `pipe-row ${accessClass(t)}`);
      const [accessText, accessKind] = ACCESS[t.tools] || ACCESS.all;
      row.append(el('span', 'pipe-row-name', t.name), el('span', null, `×${runs}`), el('span', `pipe-chip ${accessKind}`, accessText),
        el('span', t.model === 'inherit' ? 'dim' : 'strong', modelName(t.model)),
        el('span', t.effort ? 'strong' : 'dim', t.effort ? P.EFFORTS.find(([x]) => x === t.effort)?.[1] : 'Agent\'s'),
        el('span', null, fmt(v.instructions)), el('span', null, approx + fmt(v.tools)), el('span', null, e.measured ? fmt(v.memory) : '?'),
        el('span', 'strong', approx + fmt(v.total)));
      table.appendChild(row);
    }
    estimateBox.append(el('div', 'pipe-estimate-sub', 'Each sub-agent'), table,
      el('div', 'settings-hint pipe-estimate-foot', 'This is the baseline: the smallest each request can be. Every request also carries the conversation so far (for a sub-agent: what the governor hands it, then its own tool results), and an agent makes one request per step it takes. Claude Code caches the repeated part, so the baseline costs much less after an agent\'s first request.'));
  };

  // The first time the panel is on screen, measure (only Claude Code
  // starting, no message), unless a measurement from before is there.
  if (!pipeMeasured && window.IntersectionObserver) {
    const seen = new IntersectionObserver(entries => {
      if (!entries.some(x => x.isIntersecting)) return;
      seen.disconnect();
      if (!root.classList.contains('off')) measure();
    });
    requestAnimationFrame(() => seen.observe(estimateBox));
  }

  loadSkills();
  renderProfiles();
  render();
  renderTypes();

  return {
    element: root,
    value: () => {
      syncProfile();
      const { enabled, ...rest } = P.normalize(all);
      return rest;
    },
    problems: () => P.validate(cfg),
    show: () => {
      origin = null;
      render();
    },
  };
}

window.pipelineEditor = pipelineEditor;
