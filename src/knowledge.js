// Tactile's knowledge for agents, as Tactile Create gives its own: agents
// look up Tactile's conventions and examples before they design or write
// non-trivial game code, in two collections of Tactile Cortex (the Tactile
// Cortex connector, which a claude.ai account at Tactile has):
//
//   games-knowledge-database     examples and explanations people wrote for
//                                Tactile's Unity games (synced from the
//                                tactilegames/games-knowledge-database repo)
//   agent-experience-knowledge   lessons mined from earlier agent sessions
//
// The entries come from many games (merge, match-3, conveyor belts, 3D), so
// Settings → Agents → Knowledge to skip lists, per project, what a project's
// agents should leave out: "MergeTavern: conveyor belts, match-3". A project
// is any folder of the agent's path with that name.
//
// Claude agents get a helper agent for it, the knowledge-retriever (on
// Sonnet, with only the two Cortex tools): it does the searching and the
// reading, and hands back only the few entries that matter, so the main
// agent's conversation does not carry every search result through the rest
// of the task. Its report ends with a KNOWLEDGE-USED list, which the chat
// shows as the task's Tactile knowledge row (render.js). Codex agents have no
// helpers: they search themselves.
//
// knowledgePrompt(config, cwd, { helper }) is added to the instructions of
// every agent that starts (agents.js, codex.js), retrieverAgents(config, cwd)
// is the helper for Claude's --agents; '' and null while Settings → Agents →
// Tactile knowledge is off.

const path = require('path');

const RETRIEVER = 'knowledge-retriever';

// "MergeTavern: conveyor belts, match-3" lines -> { MergeTavern: 'conveyor belts, match-3' }.
function parseSkips(text) {
  const skips = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) skips[m[1]] = m[2];
  }
  return skips;
}

// What this agent's project skips: the entries whose project names a folder
// of cwd (any letter case).
function skipsFor(config, cwd) {
  const folders = new Set(path.resolve(cwd || '.').split(/[\\/]/).filter(Boolean).map(p => p.toLowerCase()));
  const skips = config.knowledgeSkip && typeof config.knowledgeSkip === 'object' ? config.knowledgeSkip : {};
  return Object.entries(skips).filter(([project, topics]) => topics && folders.has(project.trim().toLowerCase())).map(([, topics]) => topics.trim());
}

const skipLine = skips => (skips.length ? [`This project does not use some of what the entries cover: leave out entries about ${skips.join('; ')}.`] : []);

const COLLECTIONS = [
  '- games-knowledge-database: examples and explanations people wrote for Tactile\'s Unity/C# games (merge boards and gameboards, SystemComposers and facades, Fibers, UI, cameras, input, testing). The stronger source.',
  '- agent-experience-knowledge: lessons mined from earlier agent sessions. Useful leads, weaker evidence.',
];

// helper: the agent has the knowledge-retriever (Claude); without it
// (Codex), it searches itself.
function knowledgePrompt(config, cwd, { helper = false } = {}) {
  if (config.knowledge === false) return '';
  const skips = skipsFor(config, cwd);
  const when = 'before you design or write non-trivial game code (a new system or feature, a board mechanic, a UI flow, camera, input or animation work) and when you are stuck';
  const use = 'What you get is guidance, not a rule: follow it where it fits this project\'s own code and conventions (they win when the two differ), and say which entries you used (their titles). Skip it for small edits, and do not look up again what you already looked up in this conversation.';
  if (helper) {
    return [
      `Tactile knowledge: look up how Tactile does things ${when}. Ask the ${RETRIEVER} helper agent (the Agent tool, subagent_type "${RETRIEVER}"): tell it the task and what you need to know. It searches Tactile's knowledge in Cortex and hands back only the entries that matter, so do not search the knowledge yourself while it is available (if it is not, use the Tactile Cortex tools search_content and get_page on the collections games-knowledge-database and agent-experience-knowledge).`,
      use,
    ].join('\n');
  }
  return [
    `Tactile knowledge: if you have the Tactile Cortex tools (search_content and get_page), look up how Tactile does things ${when}, in two collections:`,
    ...COLLECTIONS,
    'Search each with search_content (its collectionKey, a plain-language question, limit 3 to 5) and read a promising hit in full with get_page.',
    use,
    ...skipLine(skips),
  ].join('\n');
}

// The Tactile Cortex connector's name as Claude Code's tools spell it:
// "claude.ai Tactile Cortex" -> mcp__claude_ai_Tactile_Cortex__search_content.
// cortexServer: the connector's id from the Connectors list, when known.
function cortexTools(cortexServer = 'claude.ai Tactile Cortex') {
  const server = String(cortexServer).replace(/[^A-Za-z0-9_-]/g, '_');
  return [`mcp__${server}__search_content`, `mcp__${server}__get_page`];
}

// The helper for Claude Code's --agents: { 'knowledge-retriever': … }, or null.
function retrieverAgents(config, cwd, cortexServer) {
  if (config.knowledge === false) return null;
  const skips = skipsFor(config, cwd);
  return {
    [RETRIEVER]: {
      description: 'Looks up Tactile\'s conventions and examples (Tactile knowledge in Cortex) for a game coding task and hands back only the 2-3 entries that matter. Use it instead of searching the knowledge yourself.',
      model: 'sonnet',
      tools: cortexTools(cortexServer),
      prompt: [
        'You look up Tactile\'s knowledge for another agent\'s game coding task. You do the broad searching and reading, so that the other agent only gets what matters.',
        'Search both collections of Tactile Cortex with search_content (its collectionKey, a plain-language question about the task, limit 5):',
        ...COLLECTIONS,
        'Read the most promising hits in full with get_page (at most four pages), and judge each against the task: does it apply to this concrete problem, in this kind of game? A high search score is not enough.',
        ...skipLine(skips),
        'Hand back the 2 or 3 entries that matter, for each: its title, why it matters for this task, and the points to follow (the rules, the order of steps, a short code shape when it helps). Say which come from agent-experience-knowledge (weaker evidence). When nothing applies, say so in one line: an empty answer is better than a stretched one.',
        'End with a line "KNOWLEDGE-USED:" and under it one line per entry you handed back or found useful: "- read | <collectionKey> | <title> | <url>" for a page you read in full, "- found | …" for one you only saw in the search results.',
      ].join('\n'),
    },
  };
}

module.exports = { knowledgePrompt, retrieverAgents, parseSkips, skipsFor, RETRIEVER };
