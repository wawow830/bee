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

Defaults go in `~/.bee/agent/settings.json`, and a session begins with them. Without it, the first model with a key,
`medium`, and a five-minute cache:

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

Enter sends. While bee works, Enter steers: bee reads what you said once the commands it is running end, in the same
turn. Alt-Enter queues it for when the turn is over. Ctrl-J is a new line. Up and Down recall what you said in the
session, Esc stops a turn, Ctrl-C clears, stops or quits. Ctrl-A, Ctrl-E, Ctrl-W and Ctrl-U edit as in a shell.

Ctrl-O shows bee's work, all that it thought and ran and what each command printed, or hides it again.

`/model`, `/thinking` and `/session` each take a value: `/model opus` is the model with `opus` in its id, and
`/session` is `new` or the title of another session here. What fits is shown under the prompt as you type. Tab goes
through it, and Enter sends the command once only one fits.

## How it works

**A session is a file.** `~/.bee/agent/sessions/<id>.jsonl` holds one line per message, setting chosen, or directory a
command left bash in, written as things happen and only ever appended. Its first line is how it began: its working
directory, the prompt with the `AGENTS.md` files, the tool, and the settings in `settings.json`.

**Every request is the file's messages.** So each begins as the last one did, and the provider's cache of it holds. The
harness reads the file before every step and keeps no other state. For each setting, `{model}`, `{thinking}`,
`{cache}` or `{cwd}`, the latest line holds.

**One tool.** `bash`: "Runs a command in bash. The working directory persists between calls; nothing else does. Returns
stdout and stderr, cut at 12,000 characters, or the image written." A command runs where the last one left bash, or in
the session's directory if that is gone. The computer is what lasts: files, and whatever a command left running.

The directory persists because Claude is trained on a shell where it does. In a fresh bash each call, whether the
prompt names the directory or a `pwd` finds it, the model puts `cd <it> &&` before every command.

**The harness states facts and gives no instructions.** It does not watch the context, summarise, or tell the model what
to do. Instructions are yours, in `AGENTS.md`, from `~/.bee/agent` and every directory from the root down to the working
directory.

**The file forgives.** A line that is not JSON is skipped. A setting whose value means nothing is skipped, and the one
before it holds.

Left out: permission prompts, sub-agents, memory, plan mode, compaction, MCP.
