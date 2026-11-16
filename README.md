# bee

A minimal agent harness. It speaks [ACP](https://agentclientprotocol.com) on stdio, so your editor is the UI. It gives
the model one tool, a Python session that stays open. A session is one append-only file.

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
| `BEE_LIMIT` | Tokens at which to compact. Without it, four fifths of the model's context window |
| `BEE_HOME` | Where sessions live. Without it, `~/.bee` |

Model and thinking level can be changed per session from the editor.

## How it works

**A session is a file.** `~/.bee/sessions/<id>.jsonl` holds one line per message, each `{id, parent, message}`. The
first line is the system prompt. The conversation is the path from the last line back to the first, and that path is the
whole request to the model. Lines are only appended, and the harness keeps no other state: it reads the file before
every step.

**One act does everything.** Appending a line under an earlier parent continues the conversation from there. Compaction
is that act with a summary under the first line; a rewind is that act under any other line. A setting is a line too
(`{model}` or `{thinking}`), and the latest one in the file wins.

**One tool.** `python` runs code in a Python process that belongs to the session, not to the harness. It keeps running
when the harness or the editor stops, so variables, functions and started processes are still there on resume. It exits
after a day without calls. Everything it writes goes to `<id>.out`; a call's result is what was written during the call,
cut to 20,000 characters.

**If the Python process dies**, the next call starts a new one that re-runs the imports and definitions from the session
file, reloads the variables it could save after the last call (`<id>.pkl`), and tells the model which names came back
and which did not. Open files, threads and child processes do not come back.

**The model controls the harness** through `bee` in its session: `bee.file` is the session file, `bee.append(...)` is
the one act above, `bee.tokens` and `bee.limit` are the context used and the compaction threshold, and `bee.mcp` is the
list of MCP servers the editor offers.

**Compaction** is a prompt and a fork: the harness asks for a summary as an ordinary turn, then appends it under the
first line. It happens when the context passes the limit, when you send `/compact`, or when the model does it itself.

**Permissions** are the editor's. Before each call the harness asks the editor to allow or reject it, and holds no
policy of its own.

**Instructions** come from `AGENTS.md` in `~/.bee` and in every directory from the root down to the working directory.
They are read once, when the session is created.

Left out: sub-agents, memory, plan mode, an MCP client, config files, a terminal UI.

## Notes

- On Linux with systemd, each Python session runs in its own user scope, `bee-<session id>.scope`, so that an editor
  which kills everything its agent started leaves it alone. `systemctl --user list-units 'bee-*'` lists them.
- Variables are saved after every call, so a session holding a lot of data pays for that on each call.
- To delete a session, delete its files.
