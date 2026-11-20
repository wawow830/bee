# bee

A minimal agent harness. It speaks [ACP](https://agentclientprotocol.com) on stdio, so your editor is the UI. It gives
the model one tool, bash. A session is one append-only file.

`bee.ts` is the harness, and `cli.ts` a terminal for it. They need nothing but Bun.

## Run

Point an ACP client at `bee.ts`. In T3 Code: **Settings → Providers → Add provider → Show more → Local ACP command**,
with the path to `bee.ts` as the executable.

Providers go in `~/.bee/agent/models.json`: `anthropic`, `openai-codex` and `google`.

```json
{
  "providers": {
    "anthropic": { "apiKey": "..." },
    "openai-codex": { "apiKey": "...", "baseUrl": "https://..." },
    "google": { "apiKey": "..." }
  }
}
```

`baseUrl` is optional: without it, `https://api.anthropic.com`, `https://chatgpt.com/backend-api/codex` and
`https://generativelanguage.googleapis.com`. The models are those each provider lists.

| Variable   | Meaning                                               |
| ---------- | ----------------------------------------------------- |
| `BEE_HOME` | Where bee keeps its files. Without it, `~/.bee/agent` |

Defaults go in `~/.bee/agent/settings.json`, and a session begins with them. Without it, the first model with a key,
`medium`, and a five-minute cache:

```json
{ "model": "anthropic/claude-opus-5-5", "thinking": "high", "cache": "long" }
```

Model, thinking and cache can be changed per session from the editor.

### In a terminal

`cli.ts` runs `bee.ts` and talks to it over ACP, as an editor would. `bun link` puts it on your path as `bee`.

```sh
bee            # new session
bee -c         # continue the latest session here
bee "…"        # start with a prompt
```

Enter sends. While bee works, Enter steers: bee reads what you said once the commands it is running end, in the same
turn, and until then it waits under the transcript. Alt-Enter queues it for when the turn is over. Enter with nothing
typed goes on from where a turn failed or was stopped, and nothing is said in the session. Ctrl-J is a new line. Up and
Down recall what you said in the session, as you left it until you send, and below it what you were typing. Esc stops a
turn, and pressed twice with nothing typed, begins `/fork`. Ctrl-C clears, stops or quits. Ctrl-A, Ctrl-E, Ctrl-W and
Ctrl-U edit as in a shell. Ctrl-V pastes an image copied.

While bee works, its work is shown: what it thinks, faint, and what it runs, after a `$`, each thing as one row, and
clicking it shows all of it. The answer is shown whole as it comes. Once the turn is over, ended or stopped, the work
folds away behind what you said, and clicking what you said or the answer unfolds it. The wheel scrolls, and Shift-drag
selects. On quitting, the transcript is left in the terminal as it was last shown.

`/model`, `/thinking`, `/cache`, `/session` and `/fork` each take a value: `/model opus` is the model with `opus` in its
id, `/session` is `new` or the title of another session here, and `/fork` is something you said in this one. A value
named whole, or without its provider, is the one meant, whatever its case. What fits is shown under the prompt as you
type. Tab goes through it, and Enter sends the command once only one fits. Anything else that starts with `/`, such as a
path, is a prompt. A setting chosen is kept in the session, but the command is not something said in it: it is shown
dark, as what this terminal says, and Up does not recall it.

A fork begins as this session did before what you said, set as it is now, with what you said back in the prompt to say
again. The session left stays as it was, so each branch is a session, called by what was first said in it, and the
screen shows the one you are in.
