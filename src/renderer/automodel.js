// The Auto model: picks Haiku, Sonnet or Opus for a task, so simple things
// run fast and cheap and hard ones get the strongest model. Fable is never
// picked: it is for exceptions, chosen by hand.
//
// Two opinions, mixed:
// - rules: instant, from your message (its length and its words: "rename",
//   "what is" lean small; "debug", "refactor", "design" lean large);
// - Haiku's rating, 1 to 3 (rateTask in agents.js), which takes a few
//   seconds and counts twice as much.
// The agent starts on the rules' pick at once; its first message waits for
// Haiku (at most a few seconds) and the model changes before it if the two
// together say so (see startAgent in app.js).
//
// Every later message is rated again the same way (Haiku with the task as
// context), and the model changes between Haiku and Opus only: up to Opus
// for harder work, down to Haiku for simpler (Sonnet is for starting normal
// tasks; see followUp). A short "yes, go ahead" keeps the model, and it
// steps up when the last turn failed or got stuck, or your message says the
// work is wrong ("still broken", "that's not right"). (A change of model
// starts the prompt cache over, so it only changes when it pays.)
//
// Haiku only does small things: a commit or push, a question, showing or
// listing something (see haikuFits). A message that asks to change, make,
// test, try or run something never goes to Haiku, however short it is and
// whatever Haiku rates it, because Haiku then had to do real work with many
// steps and often got it wrong. So a new task that rates "easy" but asks for
// work starts on Sonnet, and on Haiku a follow-up like that (also a plain
// "yes, go ahead", which approves work) moves up to Opus.
//
// Visual work always gets Opus, whatever the rating: layout, animations,
// particles and effects, shaders, UI and the like (see VISUAL), for a new
// task and for a follow-up.
//
// When the agent's Effort is "Auto" too, Auto also picks the effort, from
// the same rating (see effortFor): Haiku has no effort levels; Sonnet gets
// low, medium or high; Opus gets medium or high, high for visual work, and
// extra high when the last try on Opus failed. Effort goes up whenever a
// message needs more, but it only goes down together with a change of
// model, so the conversation does not keep changing its settings mid-task.

const autoModel = (() => {
  const MODELS = ['haiku', 'sonnet', 'opus'];
  const NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

  const HARD = /\b(debug\w*|crash\w*|race condition|deadlock|leak\w*|refactor\w*|architect\w*|design\w*|redesign|migrat\w*|rewrite|investigat\w*|why (does|is|do|did)|root cause|performance|optimi[sz]\w*|concurren\w*|security|algorithm\w*|end.to.end|across (the|all)|whole (project|code ?base|system)|implement\w*|feature)\b/gi;
  const EASY = /\b(rename|typo|spelling|what is|what does|where is|which file|explain briefly|summari[sz]e|list|show me|print|format|translate|commit|push|promote|restart|reopen|open|run the|bump|update the version|add a comment|comment out|remove the line|change the text|change the colou?r)\b/gi;

  // Visual work: always Opus. visual(text) returns the word that says so, or null.
  const VISUAL = /\b(blur\w*|squash\w*|stretch\w*|afterimage|layouts?|re-?layout\w*|animat\w*|particles?|vfx|visual\w*|shaders?|shader ?graph|tween\w*|easing|sprites?|spine|ui|ux|hud|polish\w*|juic\w*|(screen|camera) shake|glow\w*|bloom|lighting|fonts?|colou?rs?|align\w*|spacing|padding|anchor\w*|fade\w*|bounce\w*|pop.?in|(screen|view|scene) transitions?|looks? (nicer|better|good|off|wrong|weird|bad))\b/i;
  const visual = text => (VISUAL.exec(String(text || '')) || [])[0]?.toLowerCase() || null;

  // The rules' level, 1 to 3 (a fraction: how sure they are shows in how
  // far from the middle it is).
  function rules(text, { images = 0 } = {}) {
    const t = String(text || '');
    let score = 2;
    score += Math.min(2, (t.match(HARD) || []).length) * 0.5;
    score -= Math.min(2, (t.match(EASY) || []).length) * 0.5;
    if (t.length < 60) score -= 0.5;
    if (t.length > 700) score += 0.5;
    if (t.length > 1800) score += 0.5;
    if ((t.match(/```/g) || []).length >= 2) score += 0.25;   // code pasted in
    if (images) score += 0.25;
    return Math.max(1, Math.min(3, score));
  }

  // Rules and Haiku together (Haiku counts twice): the score, 1 to 3 with
  // fractions, and the level, the score rounded.
  const score = (rulesLevel, haikuLevel) => Math.max(1, Math.min(3, haikuLevel ? (rulesLevel + 2 * haikuLevel) / 3 : rulesLevel));
  const combine = (rulesLevel, haikuLevel) => Math.round(score(rulesLevel, haikuLevel));

  // The effort for the model Auto picked (level 1 to 3), from how hard the
  // task scored inside that model's range. '' is the model's default (Haiku
  // has no effort levels).
  const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];
  function effortFor(level, taskScore, { visual: isVisual = false, failed = false } = {}) {
    if (level <= 1) return '';
    if (level === 2) return failed || taskScore >= 2.25 ? 'high' : taskScore < 1.75 ? 'low' : 'medium';
    if (failed) return 'xhigh';
    return isVisual || taskScore >= 2.75 ? 'high' : 'medium';
  }

  // A message small enough for Haiku: a question, a lookup, or a commit or
  // push, that asks for no work (see the top of this file).
  const SMALL = /^\s*((yes|ok(ay)?|sure),?\s*)?(commit|push|show|list|print|what|where|which|who|when|how (many|much|is|are|does|do)|is|are|does|do|did|can you (tell|show|list)|check (for|if|whether)|explain|summari[sz]e|give me)\b|\?\s*$/i;
  const WORK = /\b(fix\w*|make|mak(es|ing)|change\w*|add\w*|implement\w*|remov\w*|delet\w*|refactor\w*|rewrit\w*|test\w*|try|retry|build\w*|creat\w*|mov(e|es|ing)|replac\w*|updat\w*|upgrad\w*|set ?up|wire|hook\w*|apply|run|rerun|redo|undo|revert\w*|option \d|go ahead|do it|clean\w* up|close|open)\b/i;
  const VCS = /^\s*((yes|ok(ay)?|sure),?\s*)?(commit|push)\b/i;   // "commit the fix" is a commit
  const haikuFits = text => {
    const t = String(text || '').trim();
    return t.length < 400 && SMALL.test(t) && (VCS.test(t) || (!WORK.test(t) && !t.match(HARD)));
  };
  // A new task's level: the rules and Haiku together, but never Haiku for
  // a message that asks for work.
  const startLevel = (rulesLevel, haikuLevel, text) => {
    const level = combine(rulesLevel, haikuLevel);
    return level === 1 && !haikuFits(text) ? 2 : level;
  };

  const modelOf = level => MODELS[Math.max(1, Math.min(3, level)) - 1];
  const nameOf = model => NAMES[model] || model;

  // A follow-up that should step up a level: the last turn failed or got
  // stuck, or you say the work is wrong.
  const UNHAPPY = /\b(still (broken|wrong|failing|not|doesn'?t|crash\w*)|not (right|working|what i)|doesn'?t work|didn'?t work|wrong|broken|again|that'?s not|try again|you missed|regress\w*)\b/i;
  function stepUp(lastStatus, text) {
    return lastStatus === 'error' || lastStatus === 'stuck' || UNHAPPY.test(String(text || ''));
  }

  // A short reply that goes on with the work as it is ("yes", "go ahead",
  // "continue"): the model stays.
  const GO_ON = /^\s*(y(es|ep|eah)?|ok(ay)?|sure|go( ahead| on)?|continue|proceed|do it|please do|sounds good|perfect|great|thanks?( you)?|nice|lgtm|approved?|confirm(ed)?)\b[\s.!,]*(please|thanks?|do it|go ahead)?[\s.!]*$/i;

  // A follow-up message: its level, from the agent's current one. The rules
  // read the message only half (a short follow-up is not a small task), and
  // Haiku rates it in the task's context (twice as much). It steps up at
  // least one level when the last turn failed or got stuck, or you say the
  // work is wrong. A short "go on" keeps the level.
  //
  // A follow-up never moves into Sonnet: switching model starts the prompt
  // cache over, and mid-task that costs more than Sonnet saves (its cache
  // reads cost as much as Opus's). So work that outgrows Haiku goes to Opus,
  // an Opus task rated "normal" stays on Opus, and only Haiku is worth
  // dropping to (it is so much cheaper that even without a cache it wins).
  // Sonnet is for starting normal tasks, where there is no cache to lose.
  function followUp(current, text, haikuLevel, lastStatus) {
    // "Yes, go ahead" keeps the model, but on Haiku it approves work.
    if (GO_ON.test(String(text || ''))) return current === 1 ? 3 : current;
    if (visual(text)) return 3;
    const r = (rules(text) + current) / 2;
    let level = combine(r, haikuLevel);
    if (stepUp(lastStatus, text)) level = Math.max(level, Math.min(3, current + 1));
    if (level === 1 && !haikuFits(text)) level = current === 1 ? 3 : current;
    if (level === 2 && current !== 2) level = current === 1 ? 3 : current;
    return level;
  }
  const goesOn = text => GO_ON.test(String(text || ''));

  // A follow-up's effort, once followUp picked its level. A short "go on"
  // keeps it; otherwise it goes up when the message needs more, and down
  // only when the model changes too.
  function followUpEffort(level, current, currentEffort, text, haikuLevel, lastStatus) {
    if (goesOn(text) && level === current) return currentEffort || '';
    const taskScore = score((rules(text) + current) / 2, haikuLevel);
    const next = effortFor(level, taskScore, { visual: !!visual(text), failed: stepUp(lastStatus, text) });
    if (level === current && EFFORTS.indexOf(next) < EFFORTS.indexOf(currentEffort || '')) return currentEffort;
    return next;
  }

  return { rules, score, combine, startLevel, haikuFits, modelOf, nameOf, stepUp, followUp, followUpEffort, effortFor, goesOn, visual, MODELS };
})();

window.autoModel = autoModel;
