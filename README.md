# codex-transcriber

A TUI tool to browse Codex session JSONL files and export them as Markdown.

## Languages
- English README: `README.md`
- 日本語 README: `README.ja.md`

## Requirements
- Node 18 or later

## Setup
```sh
npm install
```

## Run
```sh
npm start
```

Or:

```sh
node src/cli.js
```

## Environment variables
- `CODEX_SESSIONS_DIR` sets the sessions directory
- Default is `~/.codex/sessions`

## Key bindings
- Quit: `q`
- Switch focus: `Tab` (left), `1` (left), `2` (right)
- Left pane move: `j` `k` `g` `G` `f` `b` `ArrowUp` `ArrowDown`
- Right pane scroll: `j` `k` `g` `G` `f` `b` `ArrowUp` `ArrowDown` `Ctrl+u` `Ctrl+d`
- Toggle view: `m` (Markdown or Pretty)
- Export: `e` to start, `Enter` to save, `Esc` to cancel

## Internals
- `src/cli.js` boots the Ink renderer with `App`
- `src/app.js` handles TUI layout, session loading, and export

## Session loading
- Recursively scans JSONL files under `CODEX_SESSIONS_DIR`
- Reads `session_meta` from the first line of each file
- Builds the label from `session_meta.timestamp` or the timestamp in the file name
- Sorts by file `mtime` in descending order
- Falls back to `session_meta.timestamp` and then file name timestamp when `mtime` is unavailable

## Conversation extraction
- Reads JSONL line by line and prefers `event_msg`
- Treats `user_message`, `agent_message`, and `assistant_message` as conversation entries
- Falls back to `response_item` with `message`
- Skips lines starting with `# AGENTS.md`, `<environment_context>`, `<permissions instructions>`, `<INSTRUCTIONS>`
- Appends `[image N]` to user messages when images exist

## Export
- Default output directory is `process.cwd()`
- File name uses the session id when present, otherwise the JSONL file name
- Output format is Markdown with `### User` and `### Assistant`
