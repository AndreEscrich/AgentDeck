---
name: pm-comment
description: Write and post a Tactile PM task comment (revision, builds link, changes, testing notes, warning) on the task. Use whenever you are about to post or edit a comment about a change on a Tactile PM ticket (pm_create_comment, pm_update_comment), and when I run /pm-comment or ask for a PM comment, QA comment or "comment for the task" about work I committed in SVN.
---

# /pm-comment — Tactile PM task comment

Write the QA-ready comment for a Tactile PM task and post it on the task with the PM editor's formatting (see sections 4 and 5).

Arguments (all optional, in any order): a task key or URL (`ADSS-290`, `https://pm.tactilews.com/pm/items/ADSS-290`) and/or an SVN revision number.

## 0. Identify me

Read `~/.claude/claude-skills.json` (`{"svnUser": "...", "pmAuthorName": "..."}`). Any value missing there:

- **svnUser:** take the username SVN has cached for the working copy's server:

  ```bash
  svn auth "*$(svn info --show-item repos-root-url | sed -E 's#^[a-z+]+://([^/:]+).*#\1#')*" | sed -n 's/^Username: //p' | head -1
  ```

- **pmAuthorName:** the PM tools don't expose a display name, so ask me for the name to post comments under, suggesting `git config --global user.name` as the default. Call `pm_whoami` and show its email so I know which PM account will post.
- If the SVN username can't be found, ask me for it too.

Save the values to `~/.claude/claude-skills.json` (keep any other keys in the file) so later runs don't ask again. Below, `<SVN_USER>` and `<PM_AUTHOR_NAME>` mean these values.

## 1. Find the revision

If I gave a revision, use it. Otherwise find my latest commit on the branch of the current working copy:

```bash
svn info --show-item url
svn log "$(svn info --show-item url | sed -E 's#/Unity$##')" -l 15 -v --search <SVN_USER>
```

- Keep only entries whose author is exactly `<SVN_USER>`.
- If the work isn't committed yet (the change is only in the working copy, or none of my commits match it), don't write or post the comment: tell me it isn't committed and ask what to do.
- If the newest commits look like separate pieces of work (or don't obviously match the task), list the candidates (revision, date, message) and ask which one to use. If several of my consecutive commits are the same piece of work, use the **newest** revision and describe all of them under Changes.

## 2. Gather what changed

- `svn log -r <REV> -v` (and `svn diff -c <REV>` for each revision being described) to see what actually changed.
- If a task key was given, read it with the Tactile PM MCP (`pm_get_task`, `pm_list_comments`) for context, acceptance criteria and anything QA has already been asked to test.
- If the commit bumps a UPM package (`Packages/manifest.json`), describe the package changes too: read the package's git log between the old and new version (e.g. in `Packages/<package>` if embedded, or its GitHub repo via `gh`).

## 3. Check the builds

The builds page is `https://tactile.build/builds?revision=<REV>`.

- The API (`https://api.tactile.build/builds?...`) needs a Bearer token from the browser login and returns 401 otherwise, so don't try to curl it.
- Use the `claude-in-chrome` skill to open the builds page in my logged-in Chrome session and read which builds exist for the revision (project, platform, status).
- Mention problems to me **outside** the comment: no builds for the revision yet, failed builds, or builds for a different project than the task's game. Don't put build statuses in the comment itself.
- If Chrome isn't available, still use the link and tell me the builds weren't checked.

## 4. Write the comment

Write the comment as HTML in the PM editor's format: an H2 revision heading, a bold builds link, an `info` callout for Changes, a `tip` callout for Testing notes and, only when needed, a yellow `warning` callout, with one bold bullet per item. Escape `&`, `<` and `>` in the text. Use exactly this template:

```html
<h2><strong>Revision <REV>:</strong></h2><p><strong>Builds: </strong><a target="_blank" rel="noopener noreferrer nofollow" href="https://tactile.build/builds?revision=<REV>"><strong>https://tactile.build/builds?revision=<REV></strong></a></p><div data-component="info"><div class="callout-title" data-placeholder="Add a title"><strong>Changes</strong></div><div class="callout-body"><ul><li><p><strong><change 1></strong></p></li><li><p><strong><change 2></strong></p></li></ul></div></div><div data-component="tip"><div class="callout-title" data-placeholder="Add a title"><strong>Testing notes</strong></div><div class="callout-body"><ul><li><p><strong><what QA should check></strong></p></li></ul></div></div><p></p>
```

When there is something important QA must know (the change touches shared code, other screens or other games, or testing needs a setup step first), add a Warning callout right after Testing notes, before the closing `<p></p>`. Leave it out when there is nothing of that kind:

```html
<div data-component="warning"><div class="callout-title" data-placeholder="Add a title"><strong>Warning</strong></div><div class="callout-body"><ul><li><p><strong><what QA must know></strong></p></li></ul></div></div>
```

Example content (one bullet per line):

```
Revision 764882:
Builds: https://tactile.build/builds?revision=764882

Changes
- Update Loomit and all networks
- Removed Ironsource network.
- Added Pangle

Testing notes
- Just make sure the ads work as usual and all network return ads (live or test ads) (except networks that don't ever return ads to us)
```

Writing rules:

- **Changes:** one short bullet per user-visible or QA-relevant change, written for QA rather than developers. No class names, file paths or code unless QA needs them to find something (e.g. a dashboard field name). Merge small related changes into one bullet, and skip pure refactors and test-only changes.
- **Fixes for issues QA reported** (e.g. a sub-task titled "issue 1: INT plays after winning level 19 (INT unlocks at 20)"): write the bullet as `Fixed issue N: <short clarifying description>`, where the description says how it behaves now, e.g. "Fixed issue 1: If INT unlocks at level 20, they will play after completing level 20 and not 19". Don't repeat the full issue title or add the sub-task key.
- **Testing notes:** one to three short bullets saying what to check and where in the game (e.g. "Watch a PreLevel rewarded video, claim, and check that a second one is available"), plus what should stay unchanged if there's a regression risk. Base them on the task's acceptance criteria when there is a task.
- Keep it short; match the brevity of the example.

## 5. Post the comment

If a task key or URL was given:

1. Check the task's comments (`pm_list_comments`). If I already have a comment for the same revision, update it with `pm_update_comment` instead of adding a duplicate.
2. Otherwise post it with `pm_create_comment` (`key` = the task, `authorName` = `<PM_AUTHOR_NAME>`, `content` = the HTML).
3. Read the comments back and check that the HTML was stored unescaped.

Then reply with at most a few lines: the task link, the revision(s) used, a plain-text preview of the Changes and Testing notes, and anything about the builds I should know.

If no task was given, don't post anything. Reply with the HTML in a single fenced code block and ask which task to post it to.
