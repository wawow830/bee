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
turn, and until then it waits under the transcript. Alt-Enter queues it for when the turn is over. Ctrl-J is a new line.
Up and Down recall what you said in the session, as you left it until you send, and below it what you were typing. Esc
stops a turn, and pressed twice with nothing typed, begins `/fork`. Ctrl-C clears, stops or quits. Ctrl-A, Ctrl-E,
Ctrl-W and Ctrl-U edit as in a shell. Ctrl-V pastes an image copied.

While bee works, its work is shown: what it thinks and runs, each thing as one row, and clicking it shows all of it.
The answer is shown whole as it comes. Once the turn is over, ended or stopped, the work folds away behind what you
said, and clicking what you said or the answer unfolds it. The wheel scrolls, and Shift-drag selects. On quitting, the
transcript is left in the terminal as it was last shown.

`/model`, `/thinking`, `/session` and `/fork` each take a value: `/model opus` is the model with `opus` in its id,
`/session` is `new` or the title of another session here, and `/fork` is something you said in this one. A value named
whole, or without its provider, is the one meant, whatever its case. What fits is shown under the prompt as you type.
Tab goes through it, and Enter sends the command once only one fits. Anything else that starts with `/`, such as a path,
is a prompt. A setting chosen is kept in the session, but the command is not something said in it: it is shown dark, as
what this terminal says, and Up does not recall it.

A fork begins as this session did before what you said, set as it is now, with what you said back in the prompt to say
again. The session left stays as it was, so each branch is a session, called by what was first said in it, and the
screen shows the one you are in.

## How it works

**A session is a file.** `~/.bee/agent/sessions/<id>.jsonl` holds one line per message or setting chosen, written as
things happen and only ever appended, from the first thing said in it. Its first line is how it began: its working
directory, the prompt with the `AGENTS.md` files, the tool, and the settings in `settings.json`. A reply that runs
commands is written once they end, with what they returned, so nothing comes between a command and its output: not even
a turn in another editor on the same session.
Closing the editor or the terminal stops a turn as Esc does, so what was said and run until then is written.

**A fork is a session that begins as another did.** Its file begins with the other's lines, all of them or those before
something the user said, then `{forked}`, naming the session they are of, then the settings chosen after those lines, so
the fork is set as the session is. Nothing is undone, and a fork needs nothing of the session it names: the branches of
a conversation are sessions sharing their first lines, and a fork begins with the provider's cache of those. A fork is
called by the first thing said in it, and like a new session, has no file until then. In ACP it is `session/fork`, at a
cursor: bee gives one before each thing the user said, and tells an editor that reads cursors what the user said as it
hears it, so the editor holds what each cursor is before.

**Every request is the file's messages.** So each begins as the last one did, and the provider's cache of it holds. The
harness reads the file before every step and keeps no other state. For each setting, `{model}`, `{thinking}` or
`{cache}`, the latest line holds.

**One tool.** `bash`: "Every command starts in the working directory. Returns the output, cut at 20,000 characters, or
the image written." What a command wrote is passed through: text, cut to its first lines within 20,000 characters, or an
image. All bee says is apart from it, as "(bee: …)":
"(bee: <n> characters not shown, full output in <file>)", "(bee: no output)" and
"(bee: output is of unsupported format)"; and where a call cannot run, "(bee: tool does not exist)",
"(bee: command is not a string)" or "(bee: working directory does not exist)". The computer is what lasts: files, and
whatever a command left running.

**An image is a file.** One pasted, in the editor or with Ctrl-V, is written to a file, and its path is what you said.
The model sees an image by writing it, as with `cat`.

**bee speaks to the models itself.** A request is the file's messages, as the API takes them: a reply that failed or was
stopped is left out, a call nothing answered is answered "(bee: not run)", an answer that says nothing says
"(bee: no output)", and thinking and the ids a model gave are sent back to any model of the API they were written in.
The prompt and the conversation are each cached to their end, and Codex keeps the cache by how the session began, so a
fork shares it.

**The provider is the judge.** A request it refuses as it is, it would refuse again, so what commands returned since the
last reply is sent as "(bee: provider refused: <why>)" from then on, and the turn asks again. So a session never holds
an answer every request after is refused for.

**The harness states facts and gives no instructions.** It does not watch the context, summarise, or tell the model what
to do. Instructions are yours, in `AGENTS.md`, from `~/.bee/agent` and every directory from the root down to the working
directory.

**The file forgives.** A line that is not JSON is skipped. A setting whose value means nothing is skipped, and the one
before it holds.

Left out: permission prompts, sub-agents, memory, plan mode, compaction, MCP.
