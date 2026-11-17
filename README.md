# bee

A minimal agent harness. It speaks [ACP](https://agentclientprotocol.com) on stdio, so your editor is the UI. It gives
the model one tool, a Python session. A session is one append-only file.

Three files: `bee.ts` is the harness, `kernel.py` is the Python session, `cli.ts` is a terminal for it.

## Run

```sh
bun install
```

Point an ACP client at `bee.ts`. In T3 Code: **Settings → Providers → Add provider → Show more → Local ACP command**,
with the path to `bee.ts` as the executable.

Providers go in `~/.bee/agent/models.json`, in the format pi uses:

```json
{ "providers": { "anthropic": { "apiKey": "...", "baseUrl": "https://..." } } }
```

`baseUrl` is optional. A key in the environment that [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)
knows, such as `ANTHROPIC_API_KEY`, works too.

| Variable | Meaning |
| --- | --- |
| `BEE_HOME` | Where bee keeps its files. Without it, `~/.bee/agent` |

Defaults go in `~/.bee/agent/settings.json`, as a setting line. Without it, the first model with a key and `medium`:

```json
{ "model": "anthropic/claude-opus-4-5", "thinking": "high" }
```

Model and thinking level can be changed per session from the editor, and by the model.

### In a terminal

`cli.ts` runs `bee.ts` and talks to it over ACP, as an editor would. `bun link` puts it on your path as `bee`.

```sh
bee            # new session
bee -c         # continue the latest session here
bee "…"        # start with a prompt
```

Enter sends, Alt-Enter is a new line, Up and Down recall, Esc stops a turn, Ctrl-C clears or quits. Ctrl-A, Ctrl-E,
Ctrl-W and Ctrl-U edit as in a shell. `/model` and `/thinking` list their values; `/model <id>` sets one, and
`/model opus` the one whose id has `opus` in it. `/session` lists the other sessions here, and `/session <words>` opens the
one with them in its title.

## How it works

**A session is a file.** `~/.bee/agent/sessions/<id>.jsonl` holds one line per message, each `{parent, message}`, where
`parent` is the number of the line it follows. Line 0 is the system prompt. The conversation is the chain from the last
line back to line 0, and that chain is the whole request to the model. Lines are only appended, and the harness keeps
no other state: it reads the file before every step. The file is written with the first message, so a session never used leaves none.

**One act does everything.** Appending a line after an earlier one continues the conversation from there. Compaction is
a summary appended after line 0. A rewind is a line appended after any other. A setting is a line too, `{model}` or
`{thinking}`, and the latest one in the file holds. Line 0 starts with those in `settings.json`.

**One tool.** `python` runs code in a Python process that lasts as long as the harness does. Its result is whatever the
code and its child processes wrote, cut to 20,000 characters.

**Its variables are kept.** After every call the Python session saves what it can beside the session file. A new
Python, after the harness restarts or the old one dies, runs the session's imports and definitions again, loads the
saved variables, and tells the model which names came back. Open files, threads and child processes do not come back.

**`~/.bee/agent` is on the Python path.** A module kept there can be imported in any session.

**The model runs the harness** with that tool, by appending lines to the session file. There is no API for it, and
the prompt only says where the file is and how it chains. The harness writes each reply and its results after whatever the reply's code
appended, so the model continues from its own line. This is how it can compact its context, rewind, or change a setting.

**The harness states facts and gives no instructions.** It does not watch the context, summarise, or tell the model
what to do. Instructions are yours, in `AGENTS.md`.

**The file forgives.** A line that is not JSON, or that names no earlier line, follows the line before it.

**Instructions** come from `AGENTS.md` in `~/.bee/agent` and in every directory from the root down to the working
directory. They are read once, when the session is created.

Left out: permission prompts, sub-agents, memory, plan mode, MCP.
