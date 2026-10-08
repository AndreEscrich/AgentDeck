# Agent Hub

(Called AgentDeck before. The repository, the npm package name and the settings folder `~/Library/Application Support/agentdeck` keep the old name.)

A desktop app for running and managing Claude Code agents. You can change anything in it.

## Run it

```bash
npm install
npm start
```

You need Node.js, Git, and Claude Code installed and logged in (`claude` in a terminal, then `/login`). Agent Hub runs on macOS and Windows.

### As a clickable app

```bash
npm run make-app
```

Run this in the stable copy (see below).

- **macOS:** it builds `~/Applications/Agent Hub.app` with the Agent Hub icon and puts a link to it on your Desktop.
- **Windows:** it creates "Agent Hub" shortcuts on the Desktop and in the Start menu, with the Agent Hub icon.

Both run the code in that folder directly, so after an update you only quit and reopen Agent Hub. Run `npm run make-app` again only after `npm install` updates Electron, or after you change the icon (`build/icon.html`, then `npm run icon`, which writes `icon.png` and the Windows `icon.ico`).

### On Windows

- **Setting up the two copies:** clone the repository, then in it run `git checkout dev`, `git worktree add ../AgentDeck-stable master`, and `npm install` in both folders. Then run `npm run make-app` in `AgentDeck-stable`.
- **Shortcuts:** use Ctrl where this README says ⌘.
- **Finding Claude Code:** Agent Hub looks for `claude` in the native installer's folder (`%USERPROFILE%\.local\bin`), the npm folder (`%APPDATA%\npm`), wherever `where claude` finds it, and the Claude desktop app's own copy, and uses the newest. If it picks the wrong one, set `claudePath` in Settings.

## Two copies: stable and dev

The app you use every day and the code you change live in two separate folders, so a broken change never breaks the app you are working in. Both folders share one git history (they are git worktrees).

| Folder | Branch | Used for |
| --- | --- | --- |
| `~/Repositories/AgentDeck-stable` | `master` | Agent Hub.app runs this code. Don't edit it directly. |
| `~/Repositories/AgentDeck` | `dev` | Make and commit changes here. Test them with `npm start`, which opens a second window that runs the dev code. |

The version next to the title tells the two apart. The stable copy shows the version from `package.json` (`v0.3.0`). The dev copy shows master's major and minor version, with the number of commits it is ahead of master as the patch number, in amber: `v0.3.4 dev`.

When a change works, move it to the stable copy from the dev folder:

```bash
npm run promote
```

This moves `master` forward to `dev`, installs packages in the stable copy if they changed, and rebuilds Agent Hub.app if the icon or Electron changed. Then quit and reopen Agent Hub. To also set a version number and tag it, and to upload everything to GitHub:

```bash
npm run promote -- 0.3.0 --push
```

To go back to an earlier version, check out its tag in the stable copy (`git -C ~/Repositories/AgentDeck-stable checkout v0.2.0`), then reopen the app.

## What it does

- **New agent.** Agents start only from the message box at the bottom of the Hub (⌘N puts the cursor there). The buttons under the message box set the folder (it starts with the folder of the agent you started last; click it for recent folders or Choose folder…), the group, the permissions and the model. Press ↩ to start the agent: the box morphs into its tile.
- **Hub.** The main screen (⌘0, or ← Hub in an agent) shows every running agent as a tile with a tank of liquid. The color shows the state: blue starting, amber working (waves and bubbles, and the level rises with each step), orange needs your approval (the tile pulses), green done (a burst and a check mark when it finishes; until you open the agent, its tank keeps glowing and breathing, also after a restart), red error (the tile shakes). Each tile shows the task title, its status and how long the task took. Click a tile to open the agent: the agent's chat appears inside the tile, shrunk to fit, and in one smooth movement the tile and the chat inside it grow until the chat fills the window, while the Hub fades out underneath. Going back plays the same movement in reverse, and the tile lands in its place. After you send a message, the Hub opens and shows the agent's tile springing in (new agent) or hopping back to work (follow-up message); set `hubAfterSend` to `false` to stay in the chat instead.
- **Short titles.** A new agent is named with a summary of your message of at most 5 words, for example "Localization keys for shop offers". A quick, separate Claude Code call on Haiku writes it in about 2 seconds; until then the tile shows your message. The title is also used in History. Set `summarizeTitles` to `false` to keep your message as the title.
- **Hub groups.** Tiles are sorted into one panel per group and repository, titled "Group — Repository", so one group can have two panels when its agents work in two repositories. The repository is the nearest folder above the agent's folder that holds `.git` or `.svn` (for MergeTavern/Unity that is MergeTavern). A panel's tiles always stay on one row: they share its width and get smaller the more agents the group has (at most 240px wide each). The group button under the message box opens a panel: type a name and press ↩ to create a group, or pick one from the list. The list only shows groups that agents in the Hub use, with their agent count, so a group disappears from it when its last agent leaves; typing the exact name of such a group picks it again instead of creating a new one. Right-click a tile to move its agent to another group.
- **The Hub remembers its agents.** After a restart, or when an agent's process ends, its tile stays in the Hub as a green "Completed" tile with the time of its last task, the same as an agent that has just finished. Click it to open the session; your next message resumes it. Point at a tile and click × to remove it from the Hub (a working agent is stopped, after you confirm). The session itself stays in History. The Hub also has a message box at the bottom with the same folder, group, permissions and model buttons as a new agent: type a task and press ↩, and the box morphs into the new agent's tile and flies to its place in the grid, while you stay in the Hub. Agents that were still working when you quit continue on their own when the app opens again: the app resumes their session and tells them to continue where they stopped. Quitting (or closing the window) while agents work asks first.
- **History.** A drawer that slides in from the left (the History button in the Hub, the clock button at the top left, or ⌘\\; Esc closes it). It lists every session Claude Code has saved in `~/.claude/projects`. This includes sessions you ran in the terminal or in the Claude desktop app. Click one to read it, and type a message to continue it.
- **Categories and Groups.** A **Category** is a label you give sessions, for example one per domain. Click ＋ next to History to create one, drag a session onto it, or right-click a session and choose Move to category. Right-click a Category to rename it, move it up or down, or delete it (its sessions become uncategorized). A **Group** is one Category plus one folder, for example "Boards · MergeTavern/Unity"; the Hub shows one panel per Group. Categories are saved in `groups.json` next to `config.json`.
- **Shared context in a Group.** A new agent in a Group always starts as a fork of the Group's most recently finished agent (`claude --resume <session> --fork-session`): it begins with a copy of that agent's conversation, so it knows what that agent read, did and decided, and the original stays untouched. Agents that are still working are skipped. The line under the message box shows which agent the next one continues from. The first agent of a Group starts fresh. Every fork carries the whole conversation, so contexts grow; Claude Code summarizes them when they get too long.
- **⚙ in the message box.** Permissions and model are almost always the defaults (bypass, latest Opus, medium effort), so their menus sit behind the ⚙ button; click it to show or hide them. When the settings differ from the defaults, the button names them, for example "⚙ Plan · Sonnet 5.5".
- **Model menu.** Under the message box, also for a new agent. It lists the same models, with the same descriptions, as the Claude desktop app, because the app asks your installed Claude Code for the list. You can also set the effort level and fast mode. A change applies to the agent on screen from its next message on.
- **Permission prompts.** When an agent wants to run a command or edit a file that your permission mode and rules don't already allow, an approval card appears in the chat, and the agent's dot turns orange ("Needs approval"). You can allow it once, deny it, or pick one of Claude Code's suggested rules (for example "Always allow Bash(npm start) in this project"). Claude Code saves that rule in the project's `.claude/settings.local.json`, the same file the terminal uses.
- **Chat.** Each of your messages starts a turn. While the agent works, one line shows what it is doing right now. When it finishes, the chat shows a **Changes** card that lists every file it changed, with a diff per file, followed by its final message. The steps in between (tool calls, thinking, notes) are collapsed into one line such as "12 steps · 34s · 57k tokens", which you can click to open.
- **Catching up when you come back.** While Agent Hub is in the background, the Hub's tiles keep the state you last saw. When you switch back to it, the tiles that changed (finished, need you, stopped with an error) move to their new state one after another, each with its animation and sound, so you can see and hear what happened while you were away.
- **3D tiles.** Each tile is a thick slab lit from above with its tank set into it as a glass cylinder. Pointing at a tile tilts it toward the mouse, with the tank and text floating above the slab (not when your system asks for reduced motion).
- **Removing a group.** Point at a group's panel in the Hub and click **× Remove group** to remove all its agents at once: the tiles drop out one after another and the panel folds shut. Busy agents are stopped after one confirmation. Their sessions stay in History, and the Category itself is kept.
- **Newest message on the tile.** When you send an agent another message, its tile in the Hub shows that message instead of the first one: as you wrote it at first, then as a short summary. Hover the tile title for the full message and the original task. The agent's title in History stays the first task.
- **Skills.** When the agent runs a skill, or your message starts with `/skill-name`, a row above the answer names the skills it used. The skill's own instructions are not shown in the chat.
- **Code review.** In the Changes card, code files (`.cs`, shaders, scripts) come first and start open, with line numbers and syntax colors. Unity asset files (`.prefab`, `.asset`, `.meta`, scenes) are grouped under "Other files". The **Review** button opens all changes in the whole window, with a file list on the left (↑ ↓ to switch files, Esc to close).
- **What counts as a change.** The card lists only files inside the agent's folder that still exist when the task is done. Helper scripts the agent writes in /tmp or a scratch folder, and files it creates and deletes again during the task, are left out. A file that existed before and was deleted shows as Deleted.
- **Which message the output answers.** When your message has scrolled out of view, a card in the margin to the right of the chat shows it ("You asked …"), so it never covers the chat. In a window too narrow for that margin, it is a bar at the top of the chat instead. It follows your scrolling: in an earlier answer it shows the message of that answer. It hides while the message itself is on screen. Click it to scroll back to the message.
- **Text boxes as cards.** When an agent writes a box drawn with `╔ ═ ╗ ║ ╠ ╣ ╚ ╝` characters (for example from a skill that asks for a CHANGES summary), the chat shows it as a card: the first line in capitals is the title, `╠═╣` lines separate sections, lines in capitals (BEFORE, AFTER) are labels, `•` lines are a list (file names in the code font), lines with `──►` arrows are a chain of steps with the line below as a note per step, and `✓`/`✗` color a step green or red. The Text button shows the box as written. If a box cannot be read, it stays as text.
- **Images and videos.** Agents are told (through `--append-system-prompt`) that they can show an image or a video in the chat with a Markdown image and a file path, for example `![Grass texture](Assets/Textures/Grass.png)`; videos (mp4, webm, mov) become players. After each task, a **Media** card lists the images and videos in the agent's folder that were created or changed during the task, also when the agent did not mention them (found by modification time; Unity's Library, Temp and Logs are skipped). Click an image to see it at full size. Unity formats Chromium cannot show (tga, psd, exr, tif) are converted to a PNG preview with macOS's `sips`.
- **How changes are found.** In a git repository, the app saves a snapshot of the working tree before each message (`git stash create`, which does not change your files or your stash list) and compares the files to it when the turn ends. That way it also catches changes made by shell commands, and it leaves out changes that existed before the turn. Outside git (for example in an SVN checkout), the app keeps its own git repository for that folder in its settings folder (`snapshots/`) and records only code files there; it never writes into your folder. Embedded packages that are git repositories get their own git snapshot. Changes to non-code files outside git come from the reports that Claude Code's Edit and Write tools send.
- **Parallel agents.** Every agent is its own `claude` process. The Running list shows each agent's state: working (amber), waiting for you (green), or error (red). You get a notification when an agent finishes, asks a question or needs approval while the window is in the background; click it to open that agent. The number of agents waiting for you shows as a red badge on the Dock icon (on Windows, on the taskbar button), and the taskbar button flashes when one more starts waiting.

## Shortcuts

| Key | Action |
| --- | --- |
| ⌘N | Start a new agent (cursor in the Hub's message box) |
| ⌘0 | Hub |
| ⌘[ | Back to the Hub (also the ← Hub button in an agent; the chat shrinks back into its tile) |
| ⌘1 … ⌘9 | Switch to running agent 1–9 |
| ⌘F | Search history |
| ⌘\\ | Open or close History |
| (Windows) | Ctrl instead of ⌘ for every shortcut above |
| Esc | Back to the Hub from an agent (closes an open menu, panel or review first); the Stop button stops a running turn |
| Tab | (In the Hub, a button in the header says how many agents there are to check and which one comes first. In an agent, a glow on the right edge in the next agent's color shows "Tab to go" and its name; click it to go too.) Open the next agent to check: first agents that ask you something or need approval and that you have not opened since, then agents that finished since you last opened them, the latest first. In an agent, the next one slides in from the right. A soft flick sound plays (two low notes when there is nothing to check). With nothing to check, a short message says so. Tab does nothing else in the app. |

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | Creates the window, reads the settings file, and connects the window to the two modules below. |
| `src/platform.js` | What differs between macOS and Windows: where `claude` is installed, how to start it, the environment agents get, and stopping an agent together with the commands it started. |
| `src/agents.js` | Starts `claude -p --input-format stream-json --output-format stream-json` for each agent. It writes your messages to the process as JSON lines and forwards every JSON line the process prints back to the window. |
| `src/sessions.js` | Reads the saved `.jsonl` session files for the History drawer and the session view. |
| `src/media.js` | Serves images and videos to the window (`media://`), converts Unity formats, and finds the media a task created. |
| `src/git.js` | Takes a snapshot before each turn and lists the files that changed during it. |
| `src/preload.js` | The list of functions the window is allowed to call. |
| `src/renderer/hub.js` | The Hub: one animated tile per running agent. |
| `src/renderer/diffview.js` | Draws diffs: line numbers, syntax colors, code files first, and the full-window review view. |
| `src/renderer/boxcard.js` | Turns ╔═╗ text boxes from agents into cards. |
| `src/renderer/render.js` | Draws each turn: the collapsed steps, the final answer, the Changes card and permission cards. |
| `src/renderer/app.js` | Window state: the History drawer, switching between the Hub and agents, and the message box. |
| `src/renderer/styles.css` | All styling. The colors, fonts and sizes are variables at the top of the file. |
| `scripts/promote.js` | `npm run promote`: moves `dev` to `master` and updates the stable copy. |
| `scripts/make-app.js` | `npm run make-app`: runs `make-app.sh` on macOS or `make-app-win.ps1` on Windows. |

## Settings

Click **Settings** in the Hub (or at the bottom of History) to open `config.json`, then restart the app after you edit it.

- `claudePath`: path to the `claude` binary. When it is empty, the app finds every Claude Code installation (Homebrew, `~/.local/bin`, and the copy inside the Claude desktop app) and uses the newest one. A newer Claude Code knows about newer models.
- `defaultPermissionMode`: `bypassPermissions` (the default), `auto`, `acceptEdits`, `default` or `plan`. You can change the mode of a running agent with the menu under the message box.
- `defaultModel`: a model value from the model menu. The default is `opus`, which always means the latest Opus (Opus 5.5 today).
- `defaultEffort`: `low`, `medium` (the default), `high`, `xhigh` or `max`. Empty means the model's own default.
- `defaultFastMode`: `true` to turn fast mode on for new agents.
- `defaultFolder`: the folder for a new agent when you have not started one in Agent Hub yet.
- `extraArgs`: extra flags for every agent, for example `["--add-dir", "/some/path"]`.
- `env`: extra environment variables for every agent.
- `notifyWhenDone`: show a notification when an agent finishes or needs you.
- `sounds`: play a sound when you start an agent (and a bubbling one when its message lands in its tile in the Hub), when one asks you a question or needs your approval, when you remove one from the Hub, when one finishes, and a lower one when it stops with an error (not when you stop it). Notifications are silent while this is on. Reopen the app after changing it.
- `hubAfterSend`: open the Hub after you send a message (default `true`).
- `summarizeTitles`: name new agents with a short summary of your message (default `true`).

