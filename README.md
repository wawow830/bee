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
| `BEE_THINKING` | Default thinking level. Without it, `medium` |
| `BEE_HOME` | Where bee keeps its files. Without it, `~/.bee/agent` |

Model and thinking level can be changed per session from the editor, and by the model.

### In a terminal

Run `bee.ts` in a terminal and it is a chat (`bun link` puts it on your path as `bee`). `bee -c` continues the latest
session in the directory, and `bee "…"` starts with a prompt.

The terminal is just another editor: `cli.ts` starts `bee.ts` and speaks ACP to it, with no library. What is finished
is printed once and scrolls away; only the line being written, a status line and your input are redrawn. Esc stops a
turn, Ctrl-C clears the input or quits, and each setting is a command: `/model` lists the models, `/model <name>` picks
one.

## How it works

**A session is a file.** `~/.bee/agent/sessions/<id>.jsonl` holds one line per message, each `{parent, message}`, where
`parent` is the number of the line it follows. Line 0 is the system prompt. The conversation is the chain from the last
line back to line 0, and that chain is the whole request to the model. Lines are only appended, and the harness keeps
no other state: it reads the file before every step.

**One act does everything.** Appending a line after an earlier one continues the conversation from there. Compaction is
a summary appended after line 0. A rewind is a line appended after any other. A setting is a line too, `{model}` or
`{thinking}`, and the latest one in the file holds.

**One tool.** `python` runs code in a Python process that lasts as long as the harness does. Its result is whatever the
code and its child processes wrote, cut to 20,000 characters.

**Its variables are kept.** After every call the Python session saves what it can beside the session file. A new
Python, after the harness restarts or the old one dies, runs the session's imports and definitions again, loads the
saved variables, and tells the model which names came back. Open files, threads and child processes do not come back.

**The model runs the harness** with that tool, by appending lines to the session file. There is no API for it, and
the prompt only says where the file is. The harness writes each reply and its results after whatever the reply's code
appended, so the model continues from its own line. This is how it can compact its context, rewind, or change a setting.

**The harness states facts and gives no instructions.** It does not watch the context, summarise, or tell the model
what to do. Instructions are yours, in `AGENTS.md`.

**The file forgives.** A line that is not JSON, or that names no earlier line, follows the line before it.

**Instructions** come from `AGENTS.md` in `~/.bee/agent` and in every directory from the root down to the working
directory. They are read once, when the session is created.

Left out: permission prompts, sub-agents, memory, plan mode, MCP, config files.
