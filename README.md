# bee

A minimal agent harness. It speaks [ACP](https://agentclientprotocol.com) on stdio, so your editor is the UI. It gives
the model one tool, a Python session. A session is one append-only file.

Two files: `bee.ts` is the harness, `kernel.py` is the Python session.

## Run

```sh
bun install
```

Point an ACP client at `bee.ts`. In T3 Code: **Settings → Providers → Add provider → Show more → Local ACP command**,
with the path to `bee.ts` as the executable and the environment below.

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | Any key [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) knows makes that provider's models available |
| `<PROVIDER>_BASE_URL` | Send that provider's requests elsewhere, e.g. `ANTHROPIC_BASE_URL` for a proxy |
| `BEE_MODEL` | Default model, as `provider/id`. Without it, the first available one |
| `BEE_THINKING` | Default thinking level. Without it, `medium` |
| `BEE_HOME` | Where sessions live. Without it, `~/.bee` |

Model and thinking level can be changed per session from the editor, and by the model.

## How it works

**A session is a file.** `~/.bee/sessions/<id>.jsonl` holds one line per message, each `{parent, message}`, where
`parent` is the number of the line it follows. Line 0 is the system prompt. The conversation is the chain from the last
line back to line 0, and that chain is the whole request to the model. Lines are only appended, and the harness keeps
no other state: it reads the file before every step.

**One act does everything.** Appending a line after an earlier one continues the conversation from there. Compaction is
a summary appended after line 0. A rewind is a line appended after any other. A setting is a line too, `{model}` or
`{thinking}`, and the latest one in the file holds.

**One tool.** `python` runs code in a Python process that lasts as long as the harness does. Its result is whatever the
code and its child processes wrote, cut to 20,000 characters. When the harness restarts, the session starts empty.

**The model runs the harness** with that tool, by appending lines to the session file. There is no API for it, and
the prompt only says where the file is. The harness writes each reply and its results after whatever the reply's code
appended, so the model continues from its own line. This is how it can compact its context, rewind, or change a setting.

**The harness states facts and gives no instructions.** It does not watch the context, summarise, or tell the model
what to do. Instructions are yours, in `AGENTS.md`.

**The file forgives.** A line that is not JSON, or that names no earlier line, follows the line before it.

**Permissions** are the editor's. Before each call the harness asks the editor to allow or reject it, and holds no
policy of its own.

**Instructions** come from `AGENTS.md` in `~/.bee` and in every directory from the root down to the working directory.
They are read once, when the session is created.

Left out: sub-agents, memory, plan mode, MCP, config files, a terminal UI.
