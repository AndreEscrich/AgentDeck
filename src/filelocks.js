// File locks for the agents of a ticket run (ticketrun.js in the window):
// several agents work on one ticket's subtasks at the same time, in the same
// folder, and two of them must not change the same file at once.
//
// Each of those agents gets a PreToolUse hook on the tools that change files
// (Edit, Write, MultiEdit, NotebookEdit, and Bash commands that write).
// Claude Code asks the app before such a tool runs and waits for the answer:
// - a free file goes to the agent that asks, and stays its own until its
//   subtask is done (releaseAll, when its turn ends), so its changes to the
//   file stay together;
// - a file another agent holds makes the asking agent wait: the answer comes
//   when the file is free, and the window shows what it waits for;
// - a wait that would never end (A waits for B's file, B for A's) is a
//   deadlock: the agent that would close the circle gets a refusal that says
//   so, and can do other parts first. A wait longer than MAX_WAIT_MS too.

const path = require('path');

const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
// Bash commands that change files: in-place edits, redirections, copies, moves.
const BASH_WRITES = /\bsed\s+(?:-\S+\s+)*-i|\bperl\s+(?:-\S+\s+)*-[a-z]*i|(^|[^<>&])>{1,2}[^>&]|\btee\b|\b(mv|cp|rm|patch)\b|\bgit\s+(apply|checkout|restore)\b|\bsvn\s+(revert|patch)\b/;
// File names in a Bash command (code, Unity assets, data).
const FILE_NAME = /(?:"([^"]+\.[A-Za-z0-9]{1,12})"|'([^']+\.[A-Za-z0-9]{1,12})'|((?:[\w.@~-]+\/)*[\w.@-]+\.(?:cs|prefab|asset|controller|overrideController|anim|unity|mat|shader|hlsl|cginc|compute|asmdef|asmref|json|xml|yaml|yml|txt|csv|meta|ts|tsx|js|mjs|py|uss|uxml|inputactions)))\b/g;
const MAX_WAIT_MS = 30 * 60 * 1000;

const answer = () => ({});
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

class FileLocks {
  // onWait(agentId, { file, holder } | null): an agent starts or stops waiting.
  constructor(onWait = () => {}) {
    this.onWait = onWait;
    this.holders = new Map();   // absolute file path -> agent id
    this.waiting = new Map();   // agent id -> { file, holder, resolve, timer }
  }

  // The files a tool call would change, as absolute paths.
  filesOf(toolName, input, cwd) {
    const abs = p => path.resolve(cwd || '/', p);
    if (WRITE_TOOLS.test(toolName || '')) {
      const p = input?.file_path || input?.notebook_path;
      return typeof p === 'string' && p ? [abs(p)] : [];
    }
    if (toolName === 'Bash' && typeof input?.command === 'string' && BASH_WRITES.test(input.command)) {
      const files = new Set();
      for (const m of input.command.matchAll(FILE_NAME)) files.add(abs(m[1] || m[2] || m[3]));
      return [...files];
    }
    return [];
  }

  // The hook's answer for one tool call: once every file it changes is the
  // agent's own, or a refusal.
  async acquire(agentId, cwd, hookInput) {
    for (const file of this.filesOf(hookInput?.tool_name, hookInput?.tool_input, cwd)) {
      const refused = await this.lockOne(agentId, file);
      if (refused) return refused;
    }
    return answer();
  }

  // Would agentId waiting for holder close a circle of waits?
  circular(agentId, holder) {
    const seen = new Set();
    for (let a = holder; a && !seen.has(a); a = this.waiting.get(a)?.holder) {
      if (a === agentId) return true;
      seen.add(a);
    }
    return false;
  }

  lockOne(agentId, file) {
    const holder = this.holders.get(file);
    if (!holder || holder === agentId) {
      this.holders.set(file, agentId);
      return Promise.resolve(null);
    }
    if (this.circular(agentId, holder)) {
      return Promise.resolve(deny(`${path.basename(file)} is being changed by another agent of this ticket, and that agent waits for a file you are changing. Finish the parts of your subtask that do not need ${path.basename(file)} first; it is yours to change once that agent is done.`));
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.stopWaiting(agentId);
        resolve(deny(`${path.basename(file)} has been in use by another agent of this ticket for ${MAX_WAIT_MS / 60000} minutes. Do the parts that do not need it, or say in your answer that it is left to do.`));
      }, MAX_WAIT_MS);
      this.waiting.set(agentId, { file, holder, resolve, timer });
      this.onWait(agentId, { file, holder });
    });
  }

  stopWaiting(agentId) {
    const w = this.waiting.get(agentId);
    if (!w) return null;
    clearTimeout(w.timer);
    this.waiting.delete(agentId);
    this.onWait(agentId, null);
    return w;
  }

  // The agent's subtask is done (or it stopped): its files go to the agents
  // waiting for them, in the order they asked.
  releaseAll(agentId) {
    const own = this.stopWaiting(agentId);
    if (own) own.resolve(deny('The task was stopped.'));
    for (const [file, holder] of [...this.holders]) {
      if (holder !== agentId) continue;
      this.holders.delete(file);
      const next = [...this.waiting].find(([, w]) => w.file === file);
      if (!next) continue;
      const [nextId] = next;
      this.holders.set(file, nextId);
      this.stopWaiting(nextId).resolve(null);
      // The others waiting for this file now wait for its new holder.
      for (const [otherId, w] of [...this.waiting]) {
        if (w.file !== file) continue;
        if (this.circular(otherId, nextId)) {
          this.stopWaiting(otherId).resolve(deny(`${path.basename(file)} went to another agent that waits for a file you are changing. Finish the parts that do not need ${path.basename(file)} first.`));
        } else {
          w.holder = nextId;
          this.onWait(otherId, { file, holder: nextId });
        }
      }
    }
  }
}

module.exports = { FileLocks };
