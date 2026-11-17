# bee

A minimal agent harness. It speaks [ACP](https://agentclientprotocol.com) on stdio, so your editor is the UI. It gives
the model one tool, bash. A session is one append-only file.

Two files: `bee.ts` is the harness, `cli.ts` is a terminal for it.

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

Defaults go in `~/.bee/agent/settings.json`, as a setting line. Without it, the first model with a key, `medium`, and a five-minute cache:

```json
{ "model": "anthropic/claude-opus-4-5", "thinking": "high", "cache": "long" }
```

Model and thinking level can be changed per session from the editor.

### In a terminal

`cli.ts` runs `bee.ts` and talks to it over ACP, as an editor would. `bun link` puts it on your path as `bee`.

```sh
bee            # new session
bee -c         # continue the latest session here
bee "…"        # start with a prompt
```

Enter sends, Alt-Enter is a new line. While bee works, Enter steers: bee reads what you said once the commands it is
running end, in the same turn. Tab queues it for when the turn is over. Up and Down recall what you said in the
session, Esc stops a turn, Ctrl-C clears, stops or quits. Ctrl-A, Ctrl-E, Ctrl-W and Ctrl-U edit as in a shell.

`/model`, `/thinking` and `/session` each take a value: `/model opus` is the model with `opus` in its id, and
`/session` is `new` or the title of another session here. What fits is shown under the prompt as you type. Tab goes
through it, and Enter takes the first once only one fits.

## How it works

**A session is a file.** `~/.bee/agent/sessions/<working directory, URL-encoded>/<id>.jsonl` holds the conversation's
messages and the settings chosen in it, `{model}`, `{thinking}` or `{cache}`, one per line, written as things happen.
Its path is the session's id, and its first line is written with the first thing that happens in it, so a session never
used leaves no file. The harness reads the file before every step and keeps no other state.

**The harness supplies itself.** Each request is the session's messages, with the prompt and the tool as they are now.
The latest setting holds, and `settings.json` counts as the first line of every session.

**One tool.** `bash` runs a command in a new bash, in the working directory. Its result is whatever the command wrote,
cut to 20,000 characters. If what it wrote is an image, the model sees the image. The computer is what lasts: files,
and whatever the command left running.

**The harness states facts and gives no instructions.** It does not watch the context, summarise, or tell the model
what to do. Instructions are yours, in `AGENTS.md`.

**The file forgives.** A line that is not JSON is skipped. A setting whose value means nothing is skipped, and the one
before it holds.

**Instructions** come from `AGENTS.md` in `~/.bee/agent` and in every directory from the root down to the working
directory. They are read for every request.

Left out: permission prompts, sub-agents, memory, plan mode, compaction, MCP.
