// Ticket runs: one Tactile PM ticket with subtasks, worked on by several
// agents at once (the ⑂ button under the message box, when your message names
// a PM ticket).
//
// 1. A briefing agent reads the ticket, its subtasks and the code they are
//    about, changes nothing, and ends with the subtasks as JSON (an
//    agenthub-subtasks block).
//    For each subtask it also lists the files it will likely change and the
//    subtasks it must wait for.
// 2. Every subtask gets an agent of its own, a fork of the briefing (so it
//    knows the ticket and the code). The briefing's plan decides when each
//    starts (schedule): a subtask starts once no running subtask shares its
//    files and the subtasks it waits for are done, so independent subtasks
//    run at the same time. Settings → Agents at once (maxTicketAgents) is a
//    ceiling on top, for your usage limits. A finished agent stays in the
//    run's box with its one subtask, for review.
// 3. Workers change files under the file locks (src/filelocks.js), in case
//    the briefing missed a file: a file another worker is changing makes
//    them wait; their tile says for which file.
// 4. Each worker posts a comment on its subtask in PM. Under each finished
//    subtask, the chat has an Approve button that moves it to Done.
//
// Runs are saved (localStorage "ticketRuns", see save and load) with the
// session of the briefing and of each worker, so after a restart the agents,
// running again or parked on the Hub, are back in their run's box with their
// subtasks (laneOfSession), and the run goes on with its waiting subtasks
// (resumeRuns). Runs older than 30 days are dropped. Its agents go into the
// category picked under the message box, like any new agent, and stand
// together in a box of that Group's panel (hub.js runBox), with the ticket
// and the run's progress in the box's header. The briefing starts as a fork
// of the Group's latest finished agent (forkSourceFor in app.js), so the
// Group's shared context reaches every agent of the run.

const ticketRuns = (() => {
  const runs = new Map();   // run id -> run

  // A PM ticket in what you typed: a pm.tactilews.com link, or a key whose
  // prefix is a known PM project (see pmPrefixes in render.js).
  function keyIn(text) {
    for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"'`)]+/g)) {
      const key = pmKeyOf(m[0]);
      if (key) return key;
    }
    for (const m of String(text || '').matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g)) if (pmPrefixes.has(m[1])) return m[0];
    return null;
  }

  function briefingPrompt(key, text) {
    return [
      `Ticket run briefing for ${key}`,
      '',
      `You are the briefing agent of a ticket run in Agent Hub: after you, several agents will work on the subtasks of the Tactile PM ticket ${key} at the same time. Each of them starts as a copy of this conversation, so what you read and find here is what they know.`,
      '',
      '1. Read the ticket with pm_get_task and its subtasks with pm_list_subtasks (find the Tactile PM tools with ToolSearch). Read the descriptions and comments that matter. Find out who the user is in PM with pm_whoami, so you can tell which subtasks are assigned to them.',
      '2. Read the code and assets the ticket is about, so the area is understood: the classes, prefabs and data involved, and how they fit together. Do not change any file.',
      '3. End your answer with the ticket and every subtask, in the ticket\'s order, in a block like this one (the language must be agenthub-subtasks, the content valid JSON). The run starts its agents only when this block arrives. If you use sub-agents to read the code, wait for their results (do not run them in the background) and write the block in the same answer; do not end your answer before the block is written:',
      '',
      '```agenthub-subtasks',
      '{"ticket": {"key": "ABC-1", "title": "the ticket\'s title"},',
      ' "subtasks": [{"key": "ABC-2", "title": "the subtask\'s title", "description": "its description, short", "notes": "what you found that matters for it: files, classes, pitfalls",',
      '   "status": "its status in PM", "done": false, "assignee": "who it is assigned to, or empty", "mine": true,',
      '   "files": ["Assets/Code/Example.cs"], "after": []}]}',
      '```',
      '',
      '"done" is true when the subtask is Done, closed or resolved. "mine" is true when it is assigned to the user, false when it is assigned to someone else, and null when it has no assignee. Subtasks that are done or someone else\'s are skipped by the run, so you do not need to read code for them.',
      '"files" are the files the subtask will most likely change (paths relative to the working folder: scripts, prefabs, assets). "after" are the keys of subtasks it must wait for, because it builds on their result. The run starts subtasks that share no files at the same time, and the others one after the other, so these lists decide how fast and how safely the ticket is done: be thorough, and leave "after" empty when a subtask does not really depend on another.',
      '',
      `The user's message: ${text}`,
    ].join('\n');
  }

  function subtaskPrompt(run, sub) {
    const paragraphs = [
      `${sub.key} ${sub.title}`,
      `This is your subtask of ${run.key}${run.title ? ` (${run.title})` : ''}.`,
      sub.description && `Description (the briefing's summary): ${sub.description}`,
      sub.notes && `From the briefing: ${sub.notes}`,
      // The briefing's summary can leave out what matters (a video link,
      // steps to reproduce, a comment), so the agent reads the subtask itself.
      `Start by reading ${sub.key} in full with pm_get_task (find the Tactile PM tools with ToolSearch): its description, comments and attachments. Where they say more than the summary above, they are what counts.`,
      `Work only on ${sub.key}. Other agents are working on other subtasks of ${run.key} in this folder at the same time:\n`
        + '- When a file you want to change is being changed by one of them, Agent Hub makes you wait until it is free. If you are told a file is in use, do the parts that do not need it first.\n'
        + '- Do not undo, revert or reformat changes you did not make for this subtask.',
      `When you are done: post a comment on ${sub.key} in Tactile PM (pm_create_comment) with a short summary of what you changed and which files, then end your answer with the same summary. Do not change the subtask's status: the user approves it in Agent Hub.`,
    ];
    return paragraphs.filter(Boolean).join('\n\n');
  }

  // The briefing's subtasks, from its agenthub-subtasks block.
  function parsePlan(text) {
    const m = String(text || '').match(/```agenthub-subtasks\s*\n([\s\S]*?)```/);
    if (!m) return null;
    try {
      const data = JSON.parse(m[1]);
      const subtasks = (Array.isArray(data) ? data : data.subtasks || [])
        .filter(s => s && typeof s.key === 'string' && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(s.key))
        .map(s => ({
          key: s.key, title: String(s.title || ''), description: String(s.description || ''), notes: String(s.notes || ''),
          status: String(s.status || ''), assignee: String(s.assignee || ''),
          // A subtask that is done, or assigned to someone else, is skipped.
          done: s.done === true || /^(done|closed|resolved|released|complete|cancel)/i.test(String(s.status || '')),
          othersAssigned: s.mine === false && !!String(s.assignee || '').trim(),
          files: (Array.isArray(s.files) ? s.files : []).map(f => String(f)).filter(Boolean),
          after: (Array.isArray(s.after) ? s.after : []).map(k => String(k)).filter(k => k !== s.key),
        }));
      return subtasks.length ? { ticket: data.ticket || null, subtasks } : null;
    } catch {
      return null;
    }
  }

  // fromRect: where the message box was, for the ticket's flight into the run's box.
  async function start(key, text, fromRect = null) {
    const d = ensureDraft();
    if (!d.folder) {
      flashComposerNote('Pick a folder for the ticket run first.');
      return;
    }
    // The file locks are Claude Code hooks (filelocks.js).
    if (providerOf(startChoice(d.choice)) !== 'claude') {
      flashComposerNote('Ticket runs need Claude: pick a Claude model with ⚙ first.');
      return;
    }
    const run = {
      id: crypto.randomUUID(), createdAt: Date.now(),
      key, title: '', cwd: d.folder, groupId: d.groupId || null,
      choice: d.choice, mode: d.mode,
      status: 'briefing', briefing: null,
      subtasks: [],            // { key, title, description, notes, files, after, state: queued | working | review | approved | failed | skipped, agentId }
      forkFrom: null,          // the briefing, which every worker is a fork of
    };
    runs.set(run.id, run);
    const lane = { runId: run.id, role: 'briefing' };
    const started = startAgent({
      cwd: run.cwd, prompt: briefingPrompt(key, text), permissionMode: run.mode, choice: run.choice, groupId: run.groupId,
      forkFrom: forkSourceFor(run.cwd, run.groupId, 'claude'), lane,
    });
    run.briefing = [...state.agents.values()].find(a => a.lane === lane) || null;
    if (run.briefing) run.briefing.title = `${key} · briefing`;
    if (fromRect) hub.expectRunArrival(run.id, fromRect, key, text);
    refreshHub();
    await started;
  }

  // A worker's subtask: by the key its lane names (after a restart the agent
  // has another id), else by the agent.
  const subOf = (run, agent) => run.subtasks.find(s => (agent?.lane?.subtask ? s.key === agent.lane.subtask : s.agentId === agent?.id));

  // ---------- saved runs ----------

  const KEEP_DAYS = 30;
  const sessionOf = id => (id && state.agents.get(id)?.sessionId) || null;

  function save() {
    const list = [];
    for (const run of runs.values()) {
      if (run.test) continue;
      run.briefingSession = run.briefing?.sessionId || run.briefingSession || null;
      for (const s of run.subtasks) s.sessionId = sessionOf(s.agentId) || s.sessionId || null;
      list.push({
        id: run.id, key: run.key, title: run.title, cwd: run.cwd, groupId: run.groupId, choice: run.choice, mode: run.mode,
        status: run.status, forkFrom: run.forkFrom, briefingSession: run.briefingSession, createdAt: run.createdAt || Date.now(),
        subtasks: run.subtasks.map(({ bars, agentId, approveFailed, ...s }) => s),
      });
    }
    try { localStorage.setItem('ticketRuns', JSON.stringify(list)); } catch { /* kept for this window */ }
  }

  function load() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('ticketRuns') || '[]'); } catch { /* none */ }
    const since = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const r of list) {
      if (!r?.id || (r.createdAt || 0) < since) continue;
      const subtasks = (r.subtasks || []).map(s => ({ ...s, state: s.state === 'approving' ? 'review' : s.state, agentId: null }));
      runs.set(r.id, { ...r, subtasks, briefing: null });
    }
  }

  // The lane of a saved session (a run's briefing or one of its workers), so
  // an agent that runs again, or is parked on the Hub, is part of its run.
  function laneOfSession(sessionId) {
    if (!sessionId) return null;
    for (const run of runs.values()) {
      if ((run.briefing?.sessionId || run.briefingSession) === sessionId) return { runId: run.id, role: 'briefing' };
      const sub = run.subtasks.find(s => (sessionOf(s.agentId) || s.sessionId) === sessionId);
      if (sub) return { runId: run.id, role: 'worker', subtask: sub.key };
    }
    return null;
  }

  // An agent that runs again on a run's saved session (app.js startAgent).
  function attach(agent) {
    const run = agent?.lane && runs.get(agent.lane.runId);
    if (!run) return;
    if (agent.lane.role === 'briefing') run.briefing = agent;
    else {
      const sub = subOf(run, agent);
      if (sub) { sub.agentId = agent.id; agent.laneApproved = sub.state === 'approved'; }
    }
  }

  // After a restart: runs that were going on start the subtasks that waited
  // (agents that were working continue by themselves, see resumeInterrupted).
  function resumeRuns() {
    for (const run of runs.values()) if (run.status === 'running') schedule(run);
  }

  // Two subtasks overlap when the briefing expects them to change a file in
  // common (by path, or by name when one path is written differently).
  const fileKey = f => f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const fileName = f => fileKey(f).split('/').pop();
  function overlap(a, b) {
    const paths = new Set(a.files.map(fileKey));
    const names = new Set(a.files.map(fileName));
    return b.files.some(f => paths.has(fileKey(f)) || names.has(fileName(f)));
  }

  // Starts every waiting subtask that can start now: the subtasks it waits
  // for are finished, no running subtask shares its files, and the ceiling
  // (Settings → Agents at once) is not reached. Called when the plan arrives
  // and whenever a subtask finishes.
  function schedule(run) {
    if (run.status !== 'running') return;
    const finished = new Set(run.subtasks.filter(s => ['review', 'approving', 'approved', 'failed', 'skipped'].includes(s.state)).map(s => s.key));
    const known = new Set(run.subtasks.map(s => s.key));
    const ceiling = Math.max(1, Number(state.config.maxTicketAgents) || 5);
    const running = run.subtasks.filter(s => s.state === 'working');
    for (const sub of run.subtasks) {
      if (sub.state !== 'queued') continue;
      if (running.length >= ceiling) break;
      if (sub.after.some(k => known.has(k) && !finished.has(k))) continue;
      if (running.some(r => overlap(r, sub))) continue;
      startWorker(run, sub);
      running.push(sub);
    }
    if (!run.subtasks.some(s => ['queued', 'working'].includes(s.state))) {
      run.status = 'done';
      toast?.(`${run.key}: every subtask is done. Approve them on their tiles in the Hub.`);
    }
    save();
    refreshHub();
  }

  // A new agent for one subtask, a fork of the briefing.
  function startWorker(run, sub) {
    const lane = { runId: run.id, role: 'worker', subtask: sub.key };
    sub.state = 'working';
    startAgent({ cwd: run.cwd, prompt: subtaskPrompt(run, sub), permissionMode: run.mode, choice: run.choice, groupId: run.groupId, forkFrom: run.forkFrom, lane });
    const worker = [...state.agents.values()].find(a => a.lane === lane);
    if (worker) { sub.agentId = worker.id; worker.title = `${sub.key} ${sub.title}`; }
  }

  // The briefing is done: read its plan and start the subtasks that can start.
  function readPlan(run, agent, msg) {
    const plan = parsePlan(msg.result) || parsePlan(agent.transcript.lastFinished?.el?.innerText);
    if (!plan) {
      // The run keeps waiting: the briefing may still get its sub-agents'
      // results (background agents), or you can ask it for the block. Any
      // later answer with the block starts the agents.
      if (!run.waitingNoted) {
        run.waitingNoted = true;
        agent.transcript.note(agent.status === 'background'
          ? 'The ticket run waits for the briefing\'s subtask list: it is still waiting for its sub-agents. The agents start as soon as it writes the list.'
          : 'The ticket run waits for the briefing\'s subtask list (its agenthub-subtasks block). Ask the briefing to write it: the agents start as soon as it does.');
      }
      return;
    }
    run.title = plan.ticket?.title || '';
    // Done subtasks and other people's stay out; unassigned ones are free work.
    run.subtasks = plan.subtasks.map(s => ({ ...s, state: s.done || s.othersAssigned ? 'skipped' : 'queued', agentId: null }));
    const skipped = run.subtasks.filter(s => s.state === 'skipped');
    if (skipped.length) {
      agent.transcript.note(`Skipped ${skipped.length} subtask${skipped.length === 1 ? '' : 's'}: ${skipped.map(s => `${s.key} (${s.done ? s.status || 'done' : `assigned to ${s.assignee}`})`).join(', ')}.`);
    }
    const todo = run.subtasks.filter(s => s.state === 'queued');
    if (!todo.length) {
      run.status = 'done';
      agent.transcript.note('Every subtask of this ticket is done or assigned to someone else, so no agents start.');
      save();
      refreshHub();
      return;
    }
    run.status = 'running';
    run.forkFrom = { sessionId: agent.sessionId, title: agent.title, provider: 'claude' };
    schedule(run);
    const now = run.subtasks.filter(s => s.state === 'working').length;
    agent.transcript.note(`Ticket run: ${todo.length} subtask${todo.length === 1 ? '' : 's'}, each on an agent of its own. ${now} start${now === 1 ? 's' : ''} now; the others start when the subtasks that share their files, or that they wait for, are done (at most ${Math.max(1, Number(state.config.maxTicketAgents) || 5)} at once, Settings → Ticket runs).`);
  }

  // Approves a finished subtask: it moves to Done in PM. From the Approve
  // button on its tile (hub.js) or under its answer in the chat.
  async function approve(agentId) {
    // A parked tile (after a restart) has the id "p:" + its session.
    const agent = state.agents.get(agentId)
      || (String(agentId).startsWith('p:') ? { id: agentId, lane: laneOfSession(String(agentId).slice(2)) } : null);
    const run = agent?.lane && runs.get(agent.lane.runId);
    const sub = run && subOf(run, agent);
    if (!sub || sub.state !== 'review') return;
    sub.state = 'approving';
    renderBars(sub);
    refreshHub();
    const moved = await window.deck.pmDone([sub.key], run.key).catch(() => ({}));
    sub.state = moved?.[sub.key] ? 'approved' : 'review';
    sub.approveFailed = !moved?.[sub.key];
    if (sub.state === 'approved') agent.laneApproved = true;
    save();
    renderBars(sub);
    refreshHub();
  }

  // The Approve bar under a finished subtask's answer, kept in step with the
  // subtask's state (the tile's button changes it too).
  function renderBars(sub) {
    for (const bar of sub.bars || []) {
      const label = bar.querySelector('.ticket-approve-label');
      const button = bar.querySelector('button');
      bar.classList.toggle('approved', sub.state === 'approved');
      if (sub.state === 'approved') {
        label.textContent = `${sub.key} is approved and in Done.`;
        button?.remove();
      } else if (sub.state === 'approving') {
        label.textContent = `Moving ${sub.key} to Done…`;
        if (button) button.disabled = true;
      } else {
        label.textContent = sub.approveFailed
          ? `${sub.key} could not be moved to Done in PM. Try again, or move it there yourself.`
          : `${sub.key} is waiting for your approval. Approve it to move it to Done in PM.`;
        if (button) { button.disabled = false; button.textContent = 'Approve → Done'; }
      }
    }
  }

  function approveBar(run, sub, agent) {
    const bar = el('div', 'ticket-approve');
    const button = el('button', 'primary', 'Approve → Done');
    button.onclick = () => approve(agent.id);
    bar.append(el('span', 'ticket-approve-label'), button);
    (sub.bars = sub.bars || []).push(bar);
    renderBars(sub);
    const turn = agent.transcript.lastFinished?.el;
    (turn || agent.view).appendChild(bar);
  }

  // A worker's subtask state, for its tile (hub.js): review is "Waiting approval".
  function laneState(agent) {
    const run = agent?.lane && runs.get(agent.lane.runId);
    return (run && subOf(run, agent)?.state) || null;
  }

  function onResult(agent, msg) {
    const lane = agent?.lane;
    const run = lane && runs.get(lane.runId);
    if (!run) return;
    if (lane.role === 'briefing') {
      if (run.status === 'briefing' && !msg.is_error) readPlan(run, agent, msg);
      return;
    }
    // A worker keeps its one subtask: when you write to it afterwards, its
    // next answer counts for the same subtask.
    const sub = subOf(run, agent);
    if (sub && sub.state === 'working') {
      sub.state = msg.is_error ? 'failed' : 'review';
      if (!msg.is_error) approveBar(run, sub, agent);
    }
    schedule(run);
  }

  // A run's box in the Hub (hub.js runBox): the ticket and the progress.
  // The PM ticket an agent of a run works for: a worker's subtask (with its
  // parent ticket), or the briefing's ticket. null for any other agent.
  function ticketOf(agent) {
    const run = agent?.lane && runs.get(agent.lane.runId);
    if (!run) return null;
    if (agent.lane.role === 'worker' && agent.lane.subtask) {
      const sub = run.subtasks.find(s => s.key === agent.lane.subtask);
      return { key: agent.lane.subtask, title: sub?.title || '', parent: run.key, parentTitle: run.title || '' };
    }
    return { key: run.key, title: run.title || '', parent: null, parentTitle: '' };
  }

  function infoOf(runId) {
    const run = runs.get(runId);
    if (!run) return null;
    return { key: run.key, title: run.title, progress: progressOf(run), phase: run.status, planMissing: !!run.waitingNoted && run.status === 'briefing' };
  }

  function progressOf(run) {
    if (run.status === 'briefing') return 'briefing…';
    const count = st => run.subtasks.filter(s => s.state === st).length;
    const parts = [`${count('approved') + count('review') + count('approving')}/${run.subtasks.length - count('skipped')} done`];
    if (count('working')) parts.push(`${count('working')} working`);
    if (count('review') + count('approving')) parts.push(`${count('review') + count('approving')} waiting approval`);
    if (count('queued')) parts.push(`${count('queued')} waiting`);
    if (count('failed')) parts.push(`${count('failed')} failed`);
    if (count('skipped')) parts.push(`${count('skipped')} skipped`);
    return parts.join(' · ');
  }

  // The ⑂ button shows when the Hub's message names a PM ticket.
  function renderButton() {
    const button = document.getElementById('composer-split');
    if (!button) return;
    const kind = state.current?.kind;
    const key = ['hub', 'new'].includes(kind) || !['agent', 'history', 'branches'].includes(kind) ? keyIn(document.getElementById('input').value) : null;
    button.classList.toggle('hidden', !key);
    if (key) {
      button.textContent = `⑂ Split ${key}`;
      button.title = `Instead of one agent: one agent per subtask of ${key}, in the category you picked. Subtasks that share no files run at the same time (at most ${state.config.maxTicketAgents || 5} at once, Settings → Ticket runs)`;
      button.dataset.key = key;
    }
  }

  function wire() {
    const button = document.getElementById('composer-split');
    const input = document.getElementById('input');
    input.addEventListener('input', renderButton);
    button.onclick = () => {
      const key = button.dataset.key;
      const text = input.value.trim();
      if (!key) return;
      const fromRect = document.querySelector('.composer-box')?.getBoundingClientRect() || null;
      input.value = '';
      input.dispatchEvent(new Event('input'));
      start(key, text, fromRect);
    };
  }

  return { keyIn, start, onResult, infoOf, ticketOf, laneState, save, load, laneOfSession, attach, resumeRuns, approve, renderButton, wire, parsePlan, runs };
})();

window.ticketRuns = ticketRuns;
