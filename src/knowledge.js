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
// knowledgePrompt(config, cwd) is added to the instructions of every agent
// that starts (agents.js, codex.js); '' while Settings → Agents → Tactile
// knowledge is off.

const path = require('path');

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

function knowledgePrompt(config, cwd) {
  if (config.knowledge === false) return '';
  const skips = skipsFor(config, cwd);
  return [
    'Tactile knowledge: if you have the Tactile Cortex tools (search_content and get_page), look up how Tactile does things before you design or write non-trivial game code (a new system or feature, a board mechanic, a UI flow, camera, input or animation work) and when you are stuck, in two collections:',
    '- games-knowledge-database: examples and explanations people wrote for Tactile\'s Unity/C# games (merge boards and gameboards, SystemComposers and facades, Fibers, UI, cameras, input, testing). The stronger source.',
    '- agent-experience-knowledge: lessons mined from earlier agent sessions. Useful leads, weaker evidence.',
    'Search each with search_content (its collectionKey, a plain-language question, limit 3 to 5) and read a promising hit in full with get_page. Skip it for small edits, and do not search again for what you already looked up in this conversation.',
    'What you find is guidance, not a rule: follow it where it fits this project\'s own code and conventions (they win when the two differ), and say which entries you used (their titles).',
    ...(skips.length ? [`This project does not use some of what the entries cover: leave out entries about ${skips.join('; ')}.`] : []),
  ].join('\n');
}

module.exports = { knowledgePrompt, parseSkips, skipsFor };
