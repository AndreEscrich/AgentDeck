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

This builds `~/Applications/AgentDeck.app` with the AgentDeck icon and puts a link to it on your Desktop. The app runs the code in this folder directly, so after you change the code you only quit and reopen it. Run `npm run make-app` again only after `npm install` updates Electron, or after you change the icon (`build/icon.html`, then `npm run icon`).

## What it does

- **History sidebar.** It lists every session Claude Code has saved in `~/.claude/projects`. This includes sessions you ran in the terminal or in the Claude desktop app. Click one to read it, and type a message to continue it.
- **Groups.** Click ＋ next to History to create a group, for example one per domain. Drag a session onto a group, or right-click a session and choose Move to group. Right-click a group to rename it, move it up or down, or delete it (its sessions become ungrouped). The New agent form has a Group menu, so a new agent goes into the right group from the start. Groups are saved in `groups.json` next to `config.json`.
- **Model menu.** Under the message box and in the New agent form. It lists the same models, with the same descriptions, as the Claude desktop app, because the app asks your installed Claude Code for the list. You can also set the effort level and fast mode. A change applies to the agent on screen from its next message on.
- **Permission prompts.** When an agent wants to run a command or edit a file that your permission mode and rules don't already allow, an approval card appears in the chat, and the agent's dot turns orange ("Needs approval"). You can allow it once, deny it, or pick one of Claude Code's suggested rules (for example "Always allow Bash(npm start) in this project"). Claude Code saves that rule in the project's `.claude/settings.local.json`, the same file the terminal uses.
- **Chat.** Each of your messages starts a turn. While the agent works, one line shows what it is doing right now. When it finishes, the chat shows only its final answer and a **Changes** card that lists every file it changed, with a diff you can open per file. The steps in between (tool calls, thinking, notes) are collapsed into one line such as "12 steps · 34s", which you can click to open.
- **How changes are found.** In a git repository, the app saves a snapshot of the working tree before each message (`git stash create`, which does not change your files or your stash list) and compares the files to it when the turn ends. That way it also catches changes made by shell commands, and it leaves out changes that existed before the turn. Outside git, the app uses the reports that Claude Code's Edit and Write tools send, so changes made by shell commands are not listed there.
- **Parallel agents.** Every agent is its own `claude` process. The Running list shows each agent's state: working (amber), waiting for you (green), or error (red). You get a macOS notification when an agent finishes while the window is in the background.

## Shortcuts

| Key | Action |
| --- | --- |
| ⌘N | New agent |
| ⌘1 … ⌘9 | Switch to running agent 1–9 |
| ⌘F | Search history |
| ⌘\\ | Hide or show the sidebar |
| Esc | Stop the current turn |
| ⌘↩ | Start agent (in the New agent form) |

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | Creates the window, reads the settings file, and connects the window to the two modules below. |
| `src/agents.js` | Starts `claude -p --input-format stream-json --output-format stream-json` for each agent. It writes your messages to the process as JSON lines and forwards every JSON line the process prints back to the window. |
| `src/sessions.js` | Reads the saved `.jsonl` session files for the sidebar and the history view. |
| `src/git.js` | Takes a snapshot before each turn and lists the files that changed during it. |
| `src/preload.js` | The list of functions the window is allowed to call. |
| `src/renderer/render.js` | Draws each turn: the collapsed steps, the final answer, the Changes card and permission cards. |
| `src/renderer/app.js` | Window state: the sidebar, switching between agents, and the message box. |
| `src/renderer/styles.css` | All styling. The colors, fonts and sizes are variables at the top of the file. |

## Settings

Click **Settings** in the sidebar to open `config.json`, then restart the app after you edit it.

- `claudePath`: path to the `claude` binary. When it is empty, the app finds every Claude Code installation (Homebrew, `~/.local/bin`, and the copy inside the Claude desktop app) and uses the newest one. A newer Claude Code knows about newer models.
- `defaultPermissionMode`: `bypassPermissions` (the default), `auto`, `acceptEdits`, `default` or `plan`. You can change the mode of a running agent with the menu under the message box.
- `defaultModel`: a model value from the model menu. The default is `opus`, which always means the latest Opus (Opus 5.5 today).
- `defaultEffort`: `low`, `medium` (the default), `high`, `xhigh` or `max`. Empty means the model's own default.
- `defaultFastMode`: `true` to turn fast mode on for new agents.
- `defaultFolder`: prefilled folder in the New agent form.
- `extraArgs`: extra flags for every agent, for example `["--add-dir", "/some/path"]`.
- `env`: extra environment variables for every agent.
- `notifyWhenDone`: show a notification when an agent finishes.

