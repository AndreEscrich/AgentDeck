// What kind of task an agent is on, for the Nostromo theme's tank (each kind
// has its own screen, see scanreveal.js):
//
//   code   writing or editing code (a hex dump being rewritten)
//   art    sprites, textures, materials, shaders (a planet being scanned)
//   track  fixing a bug or a crash (the motion tracker)
//   scan   reading, explaining, reviewing, searching (a star chart)
//   text   docs, messages, tickets (MU-TH-UR's terminal)
//   dock   tests, builds, commits, merges (the approach radar)
//   map    levels and scenes, and anything else (the terrain scan)
//   boot   the first moments, while it is not yet clear
//
// Your message gives the first hints (its words), then every tool the agent
// uses: the files it edits (by type), what it runs, what it reads. Recent
// tools count more than old ones, so a task that moves on from writing code
// to running the build moves on from the hex dump to the radar. A kind takes
// over only when it clearly leads, so the screen does not flicker between two.

const taskType = (() => {
  const KINDS = ['code', 'art', 'track', 'scan', 'text', 'dock', 'map'];

  // Words in your message, and the kind they hint at.
  const WORDS = [
    ['track', /\b(fix|fixes|fixing|bug|bugs|crash\w*|error|errors|exception|broken|fail\w*|debug\w*|investigat\w*|why (does|is|do|did)|nullref\w*|nre|regression|not working|doesn'?t work)\b/i],
    ['art', /\b(art|sprite\w*|texture\w*|material\w*|shader\w*|png|psd|image\w*|icon\w*|vfx|particle\w*|colou?r\w*|visual\w*|look and feel|font\w*|atlas\w*|animation\w*)\b/i],
    ['scan', /\b(explain\w*|how (does|do|is)|what (does|is)|review\w*|research\w*|look into|understand\w*|analy[sz]\w*|compare|find out|investigate how|summari[sz]e the code)\b/i],
    ['text', /\b(readme|docs?|document\w*|jira|slack|confluence|message|email|reply|changelog|release notes|write up|ticket|comment on|describe)\b/i],
    ['dock', /\b(build|builds|tests?|testing|commit\w*|push|merge\w*|promote|release|deploy\w*|ci|pipeline|compile\w*)\b/i],
    ['map', /\b(level\w*|layout\w*|scene\w*|board\w*|terrain|map)\b/i],
    ['code', /\b(implement\w*|refactor\w*|feature|function|method|class|classes|code|add support|rename|api)\b/i],
  ];

  // Edited files, by type.
  const FILES = [
    ['art', /\.(png|jpe?g|tga|psd|svg|gif|webp|mat|shader|shadergraph|hlsl|cginc|anim|controller|spriteatlas|fbx|obj|blend|vfx|uss|ttf|otf)$/i],
    ['text', /\.(md|txt|rst|adoc)$/i],
    ['map', /\.(unity|scene|tmx|ldtk)$/i],
    ['code', /\.(cs|ts|tsx|js|jsx|mjs|cjs|py|cpp|cc|c|h|hpp|java|kt|go|rs|swift|m|mm|lua|rb|php|sh|ps1|sql|css|scss|html)$/i],
  ];

  const DOCK_RUN = /\b(test|tests|jest|vitest|pytest|nunit|build|compile|msbuild|dotnet|gradle|cargo|make|npm (run|test|ci)|yarn|pnpm|tsc|lint|eslint|commit|push|merge|promote|release|deploy)\b/i;
  const SCAN_RUN = /^\s*(ls|dir|cat|type|head|tail|find|grep|rg|git (log|show|diff|blame|status)|svn (log|diff|info|cat|ls|blame))\b/i;

  // How fast old hints fade: each tool call keeps this much of the past.
  const KEEP = 0.85;

  function add(task, kind, weight) {
    task.scores[kind] = (task.scores[kind] || 0) + weight;
  }

  function fade(task) {
    for (const k of Object.keys(task.scores)) task.scores[k] *= KEEP;
  }

  // The kind that clearly leads, or null.
  function leader(task) {
    const ranked = KINDS.map(k => [k, task.scores[k] || 0]).sort((a, b) => b[1] - a[1]);
    const [first, second] = ranked;
    if (first[1] < 2) return null;
    if (first[1] < second[1] * 1.4) return null;
    return first[0];
  }

  function decide(task) {
    const lead = leader(task);
    if (!lead) return;
    // Switching from one kind to another needs a clear lead over the current one.
    if (task.kind !== 'boot' && lead !== task.kind && (task.scores[lead] || 0) < (task.scores[task.kind] || 0) * 1.5 + 1) return;
    task.kind = lead;
  }

  // A new task (or a follow-up message): start from your words.
  function start(agent, prompt) {
    const task = { kind: 'boot', scores: {}, since: Date.now(), calls: 0 };
    const text = String(prompt || '');
    for (const [kind, re] of WORDS) {
      const hits = text.match(new RegExp(re.source, 'gi'));
      if (hits) add(task, kind, Math.min(3, hits.length) * 1.5);
    }
    agent.task = task;
    decide(task);
  }

  // One tool call: what does it say about the task?
  function tool(task, name, input = {}) {
    const file = String(input.file_path || input.notebook_path || input.path || '');
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) {
      const hit = FILES.find(([, re]) => re.test(file));
      if (hit) add(task, hit[0], 2);
      else add(task, 'code', 1);
      // Writing code is also code; a level is mostly data files.
      if (/\.(asset|prefab)$/i.test(file)) add(task, /level|board|map|scene/i.test(file) ? 'map' : 'art', 1);
    } else if (/^(Read|Grep|Glob|LS|WebSearch|WebFetch)$/.test(name)) {
      if (/\.(png|jpe?g|psd|tga|gif|webp)$/i.test(file)) add(task, 'art', 1);
      else add(task, 'scan', 1);
    } else if (name === 'Bash' || name === 'PowerShell') {
      const cmd = String(input.command || '');
      if (DOCK_RUN.test(cmd)) add(task, 'dock', 2);
      else if (SCAN_RUN.test(cmd)) add(task, 'scan', 0.7);
    } else if (/^mcp__/.test(name)) {
      const n = name.toLowerCase();
      if (/jira|slack|confluence|atlassian|docs|google|mail|notion|teams/.test(n)) add(task, 'text', 2);
      else if (/unity/.test(n)) {
        if (/compile|refresh|test|build/.test(n)) add(task, 'dock', 1.5);
        else if (/console|log|error/.test(n)) add(task, 'track', 1.5);
        else if (/screenshot|texture|material|sprite|image/.test(n)) add(task, 'art', 1.5);
        else if (/scene|gameobject|hierarchy|prefab/.test(n)) add(task, 'map', 1);
      } else if (/review|diff|branch|svn|git/.test(n)) add(task, 'scan', 1);
    }
  }

  // An assistant message: each tool it calls.
  function noteMessage(agent, message) {
    const task = agent.task;
    if (!task) return;
    let any = false;
    for (const block of message?.content || []) {
      if (block.type !== 'tool_use') continue;
      fade(task);
      tool(task, block.name, block.input || {});
      task.calls++;
      any = true;
    }
    if (any) decide(task);
  }

  // A tool came back with an error: a hint that it is chasing a problem.
  function noteError(agent) {
    if (agent.task) { add(agent.task, 'track', 0.6); decide(agent.task); }
  }

  // The kind to show: boot while it is not clear (for at most a while, then
  // the terrain scan), and the terrain scan for tasks it never saw start.
  function kindOf(agent) {
    const task = agent.task;
    if (!task) return 'map';
    if (task.kind !== 'boot') return task.kind;
    const finished = agent.status === 'idle' || agent.status === 'error';
    if (finished || Date.now() - task.since > 12000) return leader(task) || 'map';
    return 'boot';
  }

  return { start, noteMessage, noteError, kindOf, KINDS };
})();

window.taskType = taskType;
