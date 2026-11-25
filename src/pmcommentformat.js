// The layout of the comments agents post on Tactile PM tickets, and the check
// that holds them to it.
//
// QA reads these comments to go and test a change, so every agent writes them
// the same way: short sections, each an ALL CAPS heading on its own line with
// "• " bullets under it, in plain text:
//
//   FIX
//   • What changed, as a player or tester sees it.
//
//   HOW TO CHECK
//   • Where to go and what to do in the game.
//
//   IMPORTANT: THIS CHANGES THE INPUT OF ALL BOARDS      (only when needed)
//   • What else the change touches, and what to test there.
//
//
// The branch and revision are never in a comment: they go in the ticket's
// Branch and Testable revision fields (PM_STATUS_PROMPT in agents.js), where
// the ticket panel and PM's board show them.
// The instructions (PROMPT) go in every agent's system prompt (agents.js).
// Before an agent's pm_create_comment or pm_update_comment runs, Claude Code
// asks Agent Hub through a PreToolUse hook; check() reads the comment, and a
// comment that does not follow the layout is refused with the reason, so the
// agent writes it again. PM never gets the badly laid out one.

const EXAMPLE = [
  'FIX',
  '• Dragging a piece off the board and letting go in an empty area no longer merges it into the last piece it passed over. The piece goes back to its own cell.',
  '',
  'HOW TO CHECK',
  '• Open the Digging Board, drag a piece over a matching piece, keep dragging off the board and let go. Nothing should merge.',
  '',
  'IMPORTANT: THIS CHANGES THE INPUT OF ALL BOARDS',
  '• The drag and drop input is shared by every board, so please test dragging on the main board, the Digging Board, Piece Obtain and Expedition.',
].join('\n');

const PROMPT = [
  'When you post or edit a comment on a Tactile PM ticket (pm_create_comment, pm_update_comment), QA reads it to go and check the change. Write it in plain text (no HTML, no Markdown), in this layout and nothing else:',
  'sections, each an ALL CAPS heading on its own line followed by lines that start with "• ", with an empty line between sections.',
  'FIX (what changed, in plain words as a player or tester sees it), then HOW TO CHECK (where to go and what to do in the game: screen, steps, cheat if there is one),',
  'then, only when the change reaches beyond the ticket (shared code, other screens or boards), a section headed "IMPORTANT: " plus what it changes, in capitals, with what else QA must test,',
  'Do not write the branch or the revision in the comment: they go in the ticket\'s Branch and Testable revision fields, not in comments or the description. For a comment that is not about a change (a question, an answer, a status note), use one fitting heading such as QUESTION or NOTE, with bullets under it.',
  'Keep each bullet to one or two short sentences. No file lists, code names or explanations of the cause unless the user asks for them. When the user dictates a comment, keep their words but put them in this layout.',
  'Agent Hub checks the layout before the comment is posted and refuses one that does not follow it. Example:\n' + EXAMPLE,
].join(' ');

// The PreToolUse hook: PM's comment tools, whatever the connector's server is
// called (mcp__<server>__pm_create_comment).
const HOOK = { matcher: 'mcp__.*__pm_(create|update)_comment', hookCallbackIds: ['pm-comment'] };

const isHeading = line => /^[A-Z0-9][A-Z0-9 :,'()/&+.\-–]*$/.test(line) && /[A-Z]{2}/.test(line) && line.length <= 80;

// What is wrong with a comment's text, or null when it follows the layout.
function check(content) {
  const text = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!text) return 'The comment is empty.';
  if (/<\/?(p|div|ul|ol|li|br|strong|b|em|h[1-6])\b/i.test(text)) return 'Write the comment as plain text, not HTML.';
  if (/^\s*(#{1,6} |\* |- |\d+\. )/m.test(text) || /\*\*[^*]+\*\*/.test(text)) return 'Write the comment as plain text, not Markdown: headings in ALL CAPS on their own line, and lines that start with "• ".';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!isHeading(lines[0])) return `The comment must start with a heading in ALL CAPS on its own line (FIX, or QUESTION or NOTE for a comment that is not about a change), but it starts with "${lines[0].slice(0, 60)}".`;
  const loose = lines.find(l => !isHeading(l) && !l.startsWith('• '));
  if (loose) return `Every line under a heading must start with "• ". This one does not: "${loose.slice(0, 80)}".`;
  const empty = lines.find((l, i) => isHeading(l) && (i === lines.length - 1 || isHeading(lines[i + 1])));
  if (empty) return `The heading "${empty}" has no "• " lines under it.`;
  const heads = lines.filter(isHeading);
  const build = heads.find(h => /^(BUILD|BRANCH|REVISION|TESTABLE REVISION)\b/.test(h));
  if (build) return `Leave out the ${build} section: the branch and revision go in the ticket's Branch and Testable revision fields (pm_update_task customFields; on the parent story for a subtask), not in a comment.`;
  if (heads.includes('FIX') && !heads.includes('HOW TO CHECK')) return 'A FIX comment needs a HOW TO CHECK section that says where and how QA can check the change in the game.';
  return null;
}

// The hook's answer to Claude Code: nothing (go on), or a refusal with the
// reason and the layout, which the agent reads and acts on.
function hookAnswer(input) {
  const problem = check(input?.tool_input?.content);
  if (!problem) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    `Agent Hub did not post this comment: ${problem} Write it again in the layout for PM comments and call the tool again. Example:\n${EXAMPLE}` } };
}

module.exports = { PROMPT, HOOK, check, hookAnswer, EXAMPLE };
