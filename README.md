# AgentDeck

A desktop app for running and managing Claude Code agents. You can change anything in it.

## Run it

```bash
npm install
npm start
```

You need Claude Code installed and logged in (`claude` in a terminal, then `/login`).

### As a Mac app

```bash
npm run make-app
```

Run this in the stable copy (see below). It builds `~/Applications/AgentDeck.app` with the AgentDeck icon and puts a link to it on your Desktop. The app runs the code in that folder directly, so after an update you only quit and reopen it. Run `npm run make-app` again only after `npm install` updates Electron, or after you change the icon (`build/icon.html`, then `npm run icon`).

## Two copies: stable and dev

The app you use every day and the code you change live in two separate folders, so a broken change never breaks the app you are working in. Both folders share one git history (they are git worktrees).

| Folder | Branch | Used for |
| --- | --- | --- |
| `~/Repositories/AgentDeck-stable` | `master` | AgentDeck.app runs this code. Don't edit it directly. |
| `~/Repositories/AgentDeck` | `dev` | Make and commit changes here. Test them with `npm start`, which opens a second window that runs the dev code. |

When a change works, move it to the stable copy from the dev folder:

```bash
npm run promote
```

This moves `master` forward to `dev`, installs packages in the stable copy if they changed, and rebuilds AgentDeck.app if the icon or Electron changed. Then quit and reopen AgentDeck. To also set a version number and tag it, and to upload everything to GitHub:

```bash
npm run promote -- 0.3.0 --push
```

To go back to an earlier version, check out its tag in the stable copy (`git -C ~/Repositories/AgentDeck-stable checkout v0.2.0`), then reopen the app.

## What it does

- **New agent.** Agents start only from the message box at the bottom of the Hub (⌘N puts the cursor there). The buttons under the message box set the folder (it starts with the folder of the agent you started last; click it for recent folders or Choose folder…), the group, the permissions and the model. Press ↩ to start the agent: the box morphs into its tile.
- **Hub.** The main screen (⌘0, or ← Hub in an agent) shows every running agent as a tile with a tank of liquid. The color shows the state: blue starting, amber working (waves and bubbles, and the level rises with each step), orange needs your approval (the tile pulses), green done (a burst and a check mark when it finishes; until you open the agent, its tank keeps glowing and breathing, also after a restart), red error (the tile shakes). Each tile shows the task title, its status and how long the task took. Click a tile to open the agent: its tank grows over the window and the chat fades in. After you send a message, the Hub opens and shows the agent's tile springing in (new agent) or hopping back to work (follow-up message); set `hubAfterSend` to `false` to stay in the chat instead.
- **Hub groups.** Tiles are sorted into one panel per group. A group's tiles always stay on one row: they share its width and get smaller the more agents the group has (at most 240px wide each). The group button under the message box opens a panel: type a name and press ↩ to create a group, or pick one from the list. The list only shows groups that agents in the Hub use, with their agent count, so a group disappears from it when its last agent leaves; typing the exact name of such a group picks it again instead of creating a new one. Right-click a tile to move its agent to another group.
- **The Hub remembers its agents.** After a restart, or when an agent's process ends, its tile stays in the Hub as a green "Completed" tile with the time of its last task, the same as an agent that has just finished. Click it to open the session; your next message resumes it. Point at a tile and click × to remove it from the Hub (a working agent is stopped, after you confirm). The session itself stays in History. The Hub also has a message box at the bottom with the same folder, group, permissions and model buttons as a new agent: type a task and press ↩, and the box morphs into the new agent's tile and flies to its place in the grid, while you stay in the Hub.
- **History.** A drawer that slides in from the left (the History button in the Hub, the clock button at the top left, or ⌘\\; Esc closes it). It lists every session Claude Code has saved in `~/.claude/projects`. This includes sessions you ran in the terminal or in the Claude desktop app. Click one to read it, and type a message to continue it.
- **Groups.** Click ＋ next to History to create a group, for example one per domain. Drag a session onto a group, or right-click a session and choose Move to group. Right-click a group to rename it, move it up or down, or delete it (its sessions become ungrouped). The group button under the message box of a new agent puts it into the right group from the start. Groups are saved in `groups.json` next to `config.json`.
- **Model menu.** Under the message box, also for a new agent. It lists the same models, with the same descriptions, as the Claude desktop app, because the app asks your installed Claude Code for the list. You can also set the effort level and fast mode. A change applies to the agent on screen from its next message on.
- **Permission prompts.** When an agent wants to run a command or edit a file that your permission mode and rules don't already allow, an approval card appears in the chat, and the agent's dot turns orange ("Needs approval"). You can allow it once, deny it, or pick one of Claude Code's suggested rules (for example "Always allow Bash(npm start) in this project"). Claude Code saves that rule in the project's `.claude/settings.local.json`, the same file the terminal uses.
- **Chat.** Each of your messages starts a turn. While the agent works, one line shows what it is doing right now. When it finishes, the chat shows a **Changes** card that lists every file it changed, with a diff per file, followed by its final message. The steps in between (tool calls, thinking, notes) are collapsed into one line such as "12 steps · 34s · 57k tokens", which you can click to open.
- **Code review.** In the Changes card, code files (`.cs`, shaders, scripts) come first and start open, with line numbers and syntax colors. Unity asset files (`.prefab`, `.asset`, `.meta`, scenes) are grouped under "Other files". The **Review** button opens all changes in the whole window, with a file list on the left (↑ ↓ to switch files, Esc to close).
- **How changes are found.** In a git repository, the app saves a snapshot of the working tree before each message (`git stash create`, which does not change your files or your stash list) and compares the files to it when the turn ends. That way it also catches changes made by shell commands, and it leaves out changes that existed before the turn. Outside git (for example in an SVN checkout), the app keeps its own git repository for that folder in its settings folder (`snapshots/`) and records only code files there; it never writes into your folder. Embedded packages that are git repositories get their own git snapshot. Changes to non-code files outside git come from the reports that Claude Code's Edit and Write tools send.
- **Parallel agents.** Every agent is its own `claude` process. The Running list shows each agent's state: working (amber), waiting for you (green), or error (red). You get a macOS notification when an agent finishes while the window is in the background.

## Shortcuts

| Key | Action |
| --- | --- |
| ⌘N | Start a new agent (cursor in the Hub's message box) |
| ⌘0 | Hub |
| ⌘[ | Back to the Hub (also the ← Hub button in an agent; the chat shrinks back into its tile) |
| ⌘1 … ⌘9 | Switch to running agent 1–9 |
| ⌘F | Search history |
| ⌘\\ | Open or close History |
| Esc | Stop the current turn |

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | Creates the window, reads the settings file, and connects the window to the two modules below. |
| `src/agents.js` | Starts `claude -p --input-format stream-json --output-format stream-json` for each agent. It writes your messages to the process as JSON lines and forwards every JSON line the process prints back to the window. |
| `src/sessions.js` | Reads the saved `.jsonl` session files for the History drawer and the session view. |
| `src/git.js` | Takes a snapshot before each turn and lists the files that changed during it. |
| `src/preload.js` | The list of functions the window is allowed to call. |
| `src/renderer/hub.js` | The Hub: one animated tile per running agent. |
| `src/renderer/diffview.js` | Draws diffs: line numbers, syntax colors, code files first, and the full-window review view. |
| `src/renderer/render.js` | Draws each turn: the collapsed steps, the final answer, the Changes card and permission cards. |
| `src/renderer/app.js` | Window state: the History drawer, switching between the Hub and agents, and the message box. |
| `src/renderer/styles.css` | All styling. The colors, fonts and sizes are variables at the top of the file. |

## Settings

Click **Settings** in the Hub (or at the bottom of History) to open `config.json`, then restart the app after you edit it.

- `claudePath`: path to the `claude` binary. When it is empty, the app finds every Claude Code installation (Homebrew, `~/.local/bin`, and the copy inside the Claude desktop app) and uses the newest one. A newer Claude Code knows about newer models.
- `defaultPermissionMode`: `bypassPermissions` (the default), `auto`, `acceptEdits`, `default` or `plan`. You can change the mode of a running agent with the menu under the message box.
- `defaultModel`: a model value from the model menu. The default is `opus`, which always means the latest Opus (Opus 5.5 today).
- `defaultEffort`: `low`, `medium` (the default), `high`, `xhigh` or `max`. Empty means the model's own default.
- `defaultFastMode`: `true` to turn fast mode on for new agents.
- `defaultFolder`: the folder for a new agent when you have not started one in AgentDeck yet.
- `extraArgs`: extra flags for every agent, for example `["--add-dir", "/some/path"]`.
- `env`: extra environment variables for every agent.
- `notifyWhenDone`: show a notification when an agent finishes.
- `hubAfterSend`: open the Hub after you send a message (default `true`).

