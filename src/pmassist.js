// The Tickets view's Haiku box (renderer/tickets.js): you write what to do
// with tickets ("assign M2S-3644 to me and move it to In Progress", "which
// of my tickets are in QA?") and the latest Haiku does it with the Tactile PM
// connector, and nothing else.
//
// Guards, from the strongest:
// - It gets only the PM tools listed here (the Claude Code CLI refuses every
//   other tool, files and shell included): reading tickets, and changes you
//   can undo (fields, status, assignee, comments, new tickets and subtasks).
//   No tool that deletes or archives anything, closes or starts a sprint,
//   changes a project, space, release or epic, or starts an agent.
// - Its instructions say the same, and that a ticket is never archived
//   (pm_update_task can archive one with isArchived: true).
// - A change to more than 10 tickets in one go is refused.

const os = require('os');
const { spawnClaude, killTree, childEnv } = require('./platform');

const SERVERS = ['mcp__claude_ai_Tactile_PM__', 'mcp__tactile-pm__', 'mcp__tactile_pm__'];
const READ = ['pm_whoami', 'pm_get_task', 'pm_search_tasks', 'pm_find_similar_tasks', 'pm_list_tasks', 'pm_list_subtasks', 'pm_list_comments',
  'pm_list_statuses', 'pm_list_task_types', 'pm_list_custom_fields', 'pm_list_epics', 'pm_get_epic', 'pm_list_sprints', 'pm_list_teams',
  'pm_list_labels', 'pm_list_components', 'pm_list_projects', 'pm_get_project', 'pm_list_task_attachments'];
const CHANGE = ['pm_create_task', 'pm_create_subtask', 'pm_update_task', 'pm_update_subtask', 'pm_create_comment', 'pm_update_comment'];
const TOOLS = SERVERS.flatMap(s => [...READ, ...CHANGE].map(t => s + t));

const PROMPT = [
  'You are the Tactile PM helper in Agent Hub\'s Tickets view. You only work with Tactile PM tickets (tasks, subtasks and their comments), using the Tactile PM tools (find them with ToolSearch).',
  'You may read tickets, and make changes that can be undone: create tickets and subtasks, change their fields, status, assignee, sprint, epic or priority, and write or edit comments.',
  'A new subtask goes to the same person as its story (give pm_create_subtask the story\'s assignee), unless the user names someone else.',
  'Never delete, archive or remove anything: never pass isArchived, never empty a ticket\'s description, and never remove a ticket from its sprint or epic unless the user asked for exactly that.',
  'Never touch sprints themselves (start, complete), projects, spaces, releases or epics, and never start agents.',
  'If the request is not about tickets, or asks for something not allowed here, do nothing and say in one sentence that this box only does ticket work you can undo.',
  'Change at most 10 tickets for one request; if it needs more, do nothing and say so.',
  'When the user says "me", "my" or "mine", that is the PM user pm_whoami returns. Status names: read them with pm_list_statuses for the ticket\'s project.',
  'Answer in a few short lines: what you did (ticket keys and the change), or what you found. Name a ticket by its key alone (like M2S-3644): the app shows its title and status. No preamble.',
].join(' ');

const running = new Map();   // id -> process

// text: the request; context: { view, list, selected } (what is on screen),
// onStep(line): what it is doing now. Resolves with { result } or { error }.
function run(config, id, text, context, onStep) {
  return new Promise(resolve => {
    const where = [
      context?.selected ? `The ticket open on screen is ${context.selected}.` : '',
      context?.space ? `The space the user works in is ${context.space}.` : '',
    ].filter(Boolean).join(' ');
    const proc = spawnClaude(config.claudePath,
      ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
        '--append-system-prompt', PROMPT,
        '--tools', 'ToolSearch', '--allowedTools', ['ToolSearch', ...TOOLS].join(',')],
      { cwd: os.tmpdir(), env: { ...childEnv(config.env), ENABLE_TOOL_SEARCH: 'true' }, stdio: ['pipe', 'pipe', 'ignore'] });
    running.set(id, proc);
    let buffer = '';
    let result = null;
    let isError = false;
    const timer = setTimeout(() => killTree(proc), 4 * 60 * 1000);
    proc.stdout.on('data', d => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'result') { result = msg.result; isError = !!msg.is_error; }
        if (msg.type !== 'assistant') continue;
        for (const b of msg.message?.content || []) {
          if (b.type !== 'tool_use') continue;
          const name = String(b.name || '').replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/^.*__/, '');
          const key = b.input?.key || b.input?.taskId || '';
          const what = { ToolSearch: 'Finding the PM tools', pm_get_task: 'Reading', pm_search_tasks: 'Searching tickets', pm_update_task: 'Changing', pm_update_subtask: 'Changing',
            pm_create_task: 'Creating a ticket', pm_create_subtask: 'Creating a subtask', pm_create_comment: 'Commenting on', pm_list_statuses: 'Reading the statuses' }[name] || name.replace(/^pm_/, '').replace(/_/g, ' ');
          onStep?.(`${what}${key && !/^[a-f\d]{24}$/.test(key) ? ` ${key}` : ''}…`);
        }
      }
    });
    proc.on('error', err => resolve({ error: String(err.message || err) }));
    proc.on('close', () => {
      clearTimeout(timer);
      running.delete(id);
      if (result === null) resolve({ error: 'Haiku stopped before it answered.' });
      else resolve(isError ? { error: String(result) } : { result: String(result) });
    });
    proc.stdin.end(`${where ? where + '\n\n' : ''}${text}`);
  });
}

function stop(id) {
  const p = running.get(id);
  if (p) killTree(p);
}

module.exports = { run, stop, TOOLS };
