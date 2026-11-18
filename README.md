# bee

A minimal agent harness. It speaks [ACP](https://agentclientprotocol.com) on stdio, so your editor is the UI. It gives
the model one tool, bash. A session is one append-only file.

Two files: `bee.ts` is the harness, `cli.ts` is a terminal for it. They need nothing but Bun.

## Run

Point an ACP client at `bee.ts`. In T3 Code: **Settings → Providers → Add provider → Show more → Local ACP command**,
with the path to `bee.ts` as the executable.

Providers go in `~/.bee/agent/models.json`, in the format pi uses:

```json
{ "providers": { "anthropic": { "apiKey": "...", "baseUrl": "https://..." } } }
```

`baseUrl` is optional. An Anthropic key that is an OAuth token, one with `sk-ant-oat` in it, is sent as Claude Code,
as the API takes one only from it: its prompt begins with Claude Code's first line.

The models are those [pi.dev](https://pi.dev) lists for each provider, in the APIs bee speaks: Anthropic's Messages,
and OpenAI's Responses as Codex takes them. bee starts with the lists it fetched last, in `~/.bee/agent/catalog`, and
fetches them again without waiting, so a new model is there the next time. A provider it has no list of yet, it waits
for.

| Variable   | Meaning                                               |
| ---------- | ----------------------------------------------------- |
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
session, Esc stops a turn, Ctrl-C clears, stops or quits. Ctrl-A, Ctrl-E, Ctrl-W and Ctrl-U edit as in a shell. Ctrl-V
pastes an image copied.

While bee works, its work is shown: what it thinks and runs, each thing as one row, and clicking it shows all of it.
The answer is shown whole as it comes. Once the turn is over, ended or stopped, the work folds away behind what you
said, and clicking what you said or the answer unfolds it. The wheel scrolls, and Shift-drag selects. On quitting, the
transcript is left in the terminal as it was last shown.

`/model`, `/thinking` and `/session` each take a value: `/model opus` is the model with `opus` in its id, and
`/session` is `new` or the title of another session here. A value named whole, or without its provider, is the one
meant, whatever its case. What fits is shown under the prompt as you type. Tab goes through it, and Enter sends the
command once only one fits. Anything else that starts with `/`, such as a path, is a prompt.

## How it works

**A session is a file.** `~/.bee/agent/sessions/<id>.jsonl` holds one line per message or setting chosen, written as
things happen and only ever appended, from the first thing said in it. Its first line is how it began: its working
directory, the prompt with the `AGENTS.md` files, the tool, and the settings in `settings.json`. A reply that runs
commands is written once they end, with what they returned, so nothing comes between a command and its output: not even
a turn in another editor on the same session.
Closing the editor or the terminal stops a turn as Esc does, so what was said and run until then is written.

**Every request is the file's messages.** So each begins as the last one did, and the provider's cache of it holds. The
harness reads the file before every step and keeps no other state. For each setting, `{model}`, `{thinking}` or
`{cache}`, the latest line holds.

**One tool.** `bash`: "Every command starts in the working directory. Returns the output, cut at 8,000 characters, or
the image written." What a command wrote is passed through: text, cut to its first lines within 8,000 characters, or an
image. All bee says is apart from it, as "(bee: …)":
"(bee: output cut, <n> characters not shown, full output in <file>)", "(bee: no output)" and
"(bee: output is of unsupported format)"; and where a call cannot run, "(bee: tool does not exist)",
"(bee: command is not a string)" or "(bee: working directory does not exist)". The computer is what lasts: files, and
whatever a command left running.

**An image is a file.** One pasted, in the editor or with Ctrl-V, is written to a file, and its path is what you said.
The model sees an image by writing it, as with `cat`. The provider is the judge of an image: a request it refuses with
one, it is asked again with the refusal in the image's place, so a session never holds one every request after is
refused for.

**bee speaks to the models itself.** A request is the file's messages, as the API takes them: a reply that failed or was
stopped is left out, a call nothing answered is answered "(bee: not run)", an answer that says nothing says
"(bee: no output)", an image a request was refused with is "(bee: not shown: <the refusal>)", and what only one model
can read, its thinking and the ids it gave, is sent back only to it. The prompt and the conversation are each cached to
their end.

**The harness states facts and gives no instructions.** It does not watch the context, summarise, or tell the model what
to do. Instructions are yours, in `AGENTS.md`, from `~/.bee/agent` and every directory from the root down to the working
directory.

**The file forgives.** A line that is not JSON is skipped. A setting whose value means nothing is skipped, and the one
before it holds.

Left out: permission prompts, sub-agents, memory, plan mode, compaction, MCP.
