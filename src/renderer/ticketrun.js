// Ticket runs: one Tactile PM ticket with subtasks, worked on by several
// agents at once (the ⑂ button under the message box, when your message names
// a PM ticket).
//
// 1. A briefing agent reads the ticket, its subtasks and the code they are
//    about, changes nothing, and ends with the subtasks as JSON (an
//    agenthub-subtasks block).
// 2. Then up to Settings → Agents at once (maxTicketAgents) worker agents
//    start, each a fork of the briefing (so each knows the ticket and the
//    code), each on one subtask. When a worker finishes a subtask, it gets
//    the next one from the queue as its next message.
// 3. Workers change files under the file locks (src/filelocks.js): a file
//    another worker is changing makes them wait; their tile says for which file.
// 4. Each worker posts a comment on its subtask in PM. Under each finished
//    subtask, the chat has an Approve button that moves it to Done.
//
// The run lives in this window (not saved yet). Its agents go into the
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
      '1. Read the ticket with pm_get_task and its subtasks with pm_list_subtasks (find the Tactile PM tools with ToolSearch). Read the descriptions and comments that matter.',
      '2. Read the code and assets the ticket is about, so the area is understood: the classes, prefabs and data involved, and how they fit together. Do not change any file.',
      '3. End your answer with the ticket and every subtask, in the ticket\'s order, in a block like this one (the language must be agenthub-subtasks, the content valid JSON):',
      '',
      '```agenthub-subtasks',
      '{"ticket": {"key": "ABC-1", "title": "the ticket\'s title"},',
      ' "subtasks": [{"key": "ABC-2", "title": "the subtask\'s title", "description": "its description, short", "notes": "what you found that matters for it: files, classes, pitfalls"}]}',
      '```',
      '',
      `The user's message: ${text}`,
    ].join('\n');
  }

  function subtaskPrompt(run, sub, next) {
    const paragraphs = [
      `${sub.key} ${sub.title}`,
      next ? 'Your previous subtask is done. This is your next one.' : `This is your subtask of ${run.key}${run.title ? ` (${run.title})` : ''}.`,
      sub.description && `Description: ${sub.description}`,
      sub.notes && `From the briefing: ${sub.notes}`,
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
        .map(s => ({ key: s.key, title: String(s.title || ''), description: String(s.description || ''), notes: String(s.notes || '') }));
      return subtasks.length ? { ticket: data.ticket || null, subtasks } : null;
    } catch {
      return null;
    }
  }

  async function start(key, text) {
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
      id: crypto.randomUUID(),
      key, title: '', cwd: d.folder, groupId: d.groupId || null,
      choice: d.choice, mode: d.mode,
      status: 'briefing', briefing: null,
      subtasks: [],            // { key, title, description, notes, state: queued | working | review | approved | failed, agentId }
      queue: [],
    };
    runs.set(run.id, run);
    const lane = { runId: run.id, role: 'briefing' };
    const started = startAgent({
      cwd: run.cwd, prompt: briefingPrompt(key, text), permissionMode: run.mode, choice: run.choice, groupId: run.groupId,
      forkFrom: forkSourceFor(run.cwd, run.groupId, 'claude'), lane,
    });
    run.briefing = [...state.agents.values()].find(a => a.lane === lane) || null;
    if (run.briefing) run.briefing.title = `${key} · briefing`;
    refreshHub();
    await started;
  }

  const subOf = (run, agent) => run.subtasks.find(s => s.agentId === agent.id && s.state === 'working');

  function feed(run, agent, sub, next) {
    sub.state = 'working';
    sub.agentId = agent.id;
    agent.lane.subtask = sub.key;
    agent.title = `${sub.key} ${sub.title}`;
    const prompt = subtaskPrompt(run, sub, next);
    if (next) {
      agent.transcript.add({ type: 'user', message: { role: 'user', content: prompt } });
      hub.wake?.(agent.id);
      sendToAgent(agent, prompt);
    }
    refreshHub();
    return prompt;
  }

  // The briefing is done: read its plan and start the workers.
  async function startWorkers(run, agent, msg) {
    const plan = parsePlan(msg.result) || parsePlan(agent.transcript.lastFinished?.el?.innerText);
    if (!plan) {
      run.status = 'failed';
      agent.transcript.note('The ticket run did not start: the briefing ended without its agenthub-subtasks block. Ask it to write the block, then start the run again.', true);
      return;
    }
    run.title = plan.ticket?.title || '';
    run.subtasks = plan.subtasks.map(s => ({ ...s, state: 'queued', agentId: null }));
    run.queue = [...run.subtasks];
    const max = Math.max(1, Number(state.config.maxTicketAgents) || 5);
    const workers = Math.min(max, run.queue.length);
    run.status = 'running';
    agent.transcript.note(`Ticket run: ${run.subtasks.length} subtasks on ${workers} agent${workers === 1 ? '' : 's'} at once (Settings → Ticket runs). Each one starts as a copy of this briefing.`);
    const forkFrom = { sessionId: agent.sessionId, title: agent.title, provider: 'claude' };
    for (let i = 0; i < workers; i++) {
      const sub = run.queue.shift();
      const lane = { runId: run.id, role: 'worker', subtask: sub.key };
      sub.state = 'working';
      startAgent({ cwd: run.cwd, prompt: subtaskPrompt(run, sub, false), permissionMode: run.mode, choice: run.choice, groupId: run.groupId, forkFrom, lane });
      const worker = [...state.agents.values()].find(a => a.lane === lane);
      if (worker) { sub.agentId = worker.id; worker.title = `${sub.key} ${sub.title}`; }
    }
    refreshHub();
  }

  // Under a finished subtask: its PM card and the Approve button.
  function approveBar(run, sub, agent) {
    const bar = el('div', 'ticket-approve');
    const label = el('span', 'ticket-approve-label', `${sub.key} is done. Approve it to move it to Done in PM.`);
    const button = el('button', 'primary', 'Approve → Done');
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = 'Moving to Done…';
      const moved = await window.deck.pmDone([sub.key]).catch(() => ({}));
      if (moved?.[sub.key]) {
        sub.state = 'approved';
        bar.classList.add('approved');
        label.textContent = `${sub.key} is approved and in Done.`;
        button.remove();
      } else {
        button.disabled = false;
        button.textContent = 'Approve → Done';
        label.textContent = `${sub.key} could not be moved to Done in PM. Try again, or move it there yourself.`;
      }
      refreshHub();
    };
    bar.append(label, button);
    const turn = agent.transcript.lastFinished?.el;
    (turn || agent.view).appendChild(bar);
  }

  function onResult(agent, msg) {
    const lane = agent?.lane;
    const run = lane && runs.get(lane.runId);
    if (!run) return;
    if (lane.role === 'briefing') {
      if (run.status === 'briefing' && !msg.is_error) startWorkers(run, agent, msg);
      return;
    }
    const sub = subOf(run, agent);
    if (sub) {
      sub.state = msg.is_error ? 'failed' : 'review';
      if (!msg.is_error) approveBar(run, sub, agent);
    }
    // The next subtask goes to this agent.
    const next = run.queue.shift();
    if (next) feed(run, agent, next, true);
    else {
      lane.subtask = null;
      if (run.subtasks.every(s => !['queued', 'working'].includes(s.state))) {
        run.status = 'done';
        toast?.(`${run.key}: every subtask is done. Approve them in their agents' chats.`);
      }
    }
    refreshHub();
  }

  // A run's box in the Hub (hub.js runBox): the ticket and the progress.
  function infoOf(runId) {
    const run = runs.get(runId);
    if (!run) return null;
    return { key: run.key, title: run.title, progress: progressOf(run) };
  }

  function progressOf(run) {
    if (run.status === 'briefing') return 'briefing…';
    const count = st => run.subtasks.filter(s => s.state === st).length;
    const parts = [`${count('approved') + count('review')}/${run.subtasks.length} done`];
    if (count('review')) parts.push(`${count('review')} to approve`);
    if (count('queued')) parts.push(`${count('queued')} waiting`);
    if (count('failed')) parts.push(`${count('failed')} failed`);
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
      button.title = `Instead of one agent: one agent per subtask of ${key}, at most ${state.config.maxTicketAgents || 5} at once (Settings → Ticket runs), in the category you picked`;
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
      input.value = '';
      input.dispatchEvent(new Event('input'));
      start(key, text);
    };
  }

  return { keyIn, start, onResult, infoOf, renderButton, wire, parsePlan, runs };
})();

window.ticketRuns = ticketRuns;
