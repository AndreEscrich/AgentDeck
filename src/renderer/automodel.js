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

const autoModel = (() => {
  const MODELS = ['haiku', 'sonnet', 'opus'];
  const NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

  const HARD = /\b(debug\w*|crash\w*|race condition|deadlock|leak\w*|refactor\w*|architect\w*|design\w*|redesign|migrat\w*|rewrite|investigat\w*|why (does|is|do|did)|root cause|performance|optimi[sz]\w*|concurren\w*|security|algorithm\w*|end.to.end|across (the|all)|whole (project|code ?base|system)|implement\w*|feature)\b/gi;
  const EASY = /\b(rename|typo|spelling|what is|what does|where is|which file|explain briefly|summari[sz]e|list|show me|print|format|translate|commit|push|promote|restart|reopen|open|run the|bump|update the version|add a comment|comment out|remove the line|change the text|change the colou?r)\b/gi;

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

  // Rules and Haiku together (Haiku counts twice): the level, 1 to 3.
  function combine(rulesLevel, haikuLevel) {
    const level = haikuLevel ? (rulesLevel + 2 * haikuLevel) / 3 : rulesLevel;
    return Math.max(1, Math.min(3, Math.round(level)));
  }

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
    if (GO_ON.test(String(text || ''))) return current;
    const r = (rules(text) + current) / 2;
    let level = combine(r, haikuLevel);
    if (stepUp(lastStatus, text)) level = Math.max(level, Math.min(3, current + 1));
    if (level === 2 && current !== 2) level = current === 1 ? 3 : current;
    return level;
  }
  const goesOn = text => GO_ON.test(String(text || ''));

  return { rules, combine, modelOf, nameOf, stepUp, followUp, goesOn, MODELS };
})();

window.autoModel = autoModel;
