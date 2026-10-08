# AgentDeck

A desktop app for running and managing Claude Code agents. You can change anything in it.

## Run it

```bash
npm install
npm start
```

You need Claude Code installed and logged in (`claude` in a terminal, then `/login`).

## What it does

- **History sidebar.** It lists every session Claude Code has saved in `~/.claude/projects`, grouped by project folder. This includes sessions you ran in the terminal or in the Claude desktop app. Click one to read it, and type a message to continue it.
- **Chat.** Replies stream in as Claude writes them. Each tool call shows as a card that you can open to see its input and its result.
- **Parallel agents.** Every agent is its own `claude` process. The Running list shows each agent's state: working (amber), waiting for you (green), or error (red). You get a macOS notification when an agent finishes while the window is in the background.

## Shortcuts

| Key | Action |
| --- | --- |
| ⌘N | New agent |
| ⌘1 … ⌘9 | Switch to running agent 1–9 |
| ⌘F | Search history |
| Esc | Stop the current turn |
| ⌘↩ | Start agent (in the New agent form) |

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | Creates the window, reads the settings file, and connects the window to the two modules below. |
| `src/agents.js` | Starts `claude -p --input-format stream-json --output-format stream-json` for each agent. It writes your messages to the process as JSON lines and forwards every JSON line the process prints back to the window. |
| `src/sessions.js` | Reads the saved `.jsonl` session files for the sidebar and the history view. |
| `src/preload.js` | The list of functions the window is allowed to call. |
| `src/renderer/render.js` | Draws messages: Markdown text, tool cards, thinking blocks, and the end-of-turn line. |
| `src/renderer/app.js` | Window state: the sidebar, switching between agents, and the message box. |
| `src/renderer/styles.css` | All styling. The colors, fonts and sizes are variables at the top of the file. |

## Settings

Click **Settings** in the sidebar to open `config.json`, then restart the app after you edit it.

- `claudePath`: path to the `claude` binary. When it is empty, the app looks in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`.
- `defaultPermissionMode`: `acceptEdits`, `default`, `plan` or `bypassPermissions`.
- `defaultModel`: for example `opus` or `sonnet`. Empty means Claude Code's own default.
- `defaultFolder`: prefilled folder in the New agent form.
- `extraArgs`: extra flags for every agent, for example `["--add-dir", "/some/path"]`.
- `env`: extra environment variables for every agent.
- `notifyWhenDone`: show a notification when an agent finishes.

## Known limits

- Agents cannot ask you for permission yet. In `default` mode, Claude refuses any tool call that would need your approval. Use `acceptEdits`, or add allowed tools in `~/.claude/settings.json`.
