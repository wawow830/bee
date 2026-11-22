import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CACHE_MODES,
  CONFIG_KEYS,
  extractText,
  firstLine,
  isMessageEntry,
  modelRef,
  parseJson,
  readText,
  rpcError,
  type CacheMode,
  type ConfigKey,
  type ConfigValues,
  type MessageEntry,
  type Model,
  type SessionHeader,
  type SessionLine,
  type ThinkingLevel,
  type ToolSchema,
} from "./types";

// Fast raw-buffer line scan for session/list so listing large histories avoids parsing every JSONL line.
const parseLineAt = (buf: Buffer, offset: number): SessionLine =>
  parseJson(buf.toString("utf8", offset, buf.indexOf("\n", offset)));

function extractTitleFromBuffer(buf: Buffer) {
  const offset = buf.indexOf('\n{"user":', buf.lastIndexOf('\n{"forked":') + 1);
  return offset < 0 ? undefined : firstLine(extractText(parseLineAt(buf, offset + 1).user!.content)) || undefined;
}

function loadInstructions(home: string, cwd: string) {
  const dirs = [cwd];
  while (dirs[0] !== dirname(dirs[0])) dirs.unshift(dirname(dirs[0]));
  return [home, ...dirs]
    .map((dir) => join(dir, "AGENTS.md"))
    .filter(existsSync)
    .map((path) => `<file path="${path}">\n${readText(path).trim()}\n</file>`)
    .join("\n\n");
}

/**
 * Append-only JSONL session store. Strictly appending preserves prompt-cache prefixes across turns.
 * Empty sessions and fresh forks stay in memory until the first message is appended.
 */
export function createSessionStore(home: string, models: Model[], tools: ToolSchema[]) {
  const sessionsDir = join(home, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

  const pathFor = (sid: string) => join(sessionsDir, `${sid}.jsonl`);
  const pending = new Map<string, SessionLine[]>();
  const cache = new Map<string, { size: number; lines: SessionLine[] }>();

  function create(cwd: string) {
    const config: ConfigValues = JSON.parse(readText(join(home, "settings.json"), "{}"));
    for (const key of CONFIG_KEYS) if (!(key in config)) throw new Error(`settings.json sets no ${key}`);
    const began: SessionHeader = {
      cwd,
      prompt: `\nYou are an agent in the bee harness.\n\n${loadInstructions(home, cwd)}`.trimEnd(),
      tools,
      timestamp: Date.now(),
    };
    const sid = randomUUID();
    pending.set(sid, [{ ...config, began }]);
    return sid;
  }

  function read(sid: string): SessionLine[] {
    const held = pending.get(sid);
    if (held) return held;
    if (!/^[\w-]+$/.test(sid) || !existsSync(pathFor(sid))) throw rpcError(-32002, `No session ${sid}`);
    const { size } = statSync(pathFor(sid));
    if (cache.get(sid)?.size !== size) {
      cache.set(sid, { size, lines: readText(pathFor(sid)).trimEnd().split("\n").map(parseJson) });
    }
    return cache.get(sid)!.lines;
  }

  function append(sid: string, ...added: SessionLine[]) {
    const held = pending.get(sid);
    if (held && !added.some(isMessageEntry)) return void held.push(...added);

    const batch = [...(held ?? []), ...added];
    const payload = batch.map((line) => JSON.stringify(line) + "\n").join("");
    let fd: number;
    try {
      // Use O_APPEND for existing sessions so a deleted file stays deleted rather than recreated headless.
      fd = openSync(pathFor(sid), held ? "wx" : constants.O_WRONLY | constants.O_APPEND);
    } catch (error: any) {
      throw error.code === "ENOENT" ? rpcError(-32002, `No session ${sid}`) : error;
    }
    try {
      writeSync(fd, payload);
      pending.delete(sid);
    } finally {
      closeSync(fd);
    }

    const bytes = Buffer.byteLength(payload);
    const size = statSync(pathFor(sid)).size;
    const cached = cache.get(sid);
    if (held && size === bytes) cache.set(sid, { size, lines: batch });
    else if (cached && cached.size + bytes === size) {
      cached.size = size;
      cached.lines.push(...added);
    }
  }

  const header = (sid: string) => read(sid)[0].began!;
  // Stable hash of the first line; shared across forks so provider prompt caches stay warm.
  const origin = (sid: string) => Bun.hash(JSON.stringify(read(sid)[0])).toString(36);
  const history = (sid: string): MessageEntry[] => read(sid).filter(isMessageEntry);

  function config(sid: string) {
    const entries = read(sid);
    return Object.fromEntries(
      CONFIG_KEYS.map((key) => [key, entries.findLast((line) => key in line)![key]!]),
    ) as Record<ConfigKey, string>;
  }

  const model = (sid: string) => models.find((m) => modelRef(m) === config(sid).model);

  function configOptions(sid: string) {
    const current = config(sid);
    const modelChoices = models.map((m) => ({ value: modelRef(m), name: m.name }));
    const [thinkingChoices, cacheChoices] = [model(sid)?.levels ?? [], CACHE_MODES].map((values) =>
      values.map((value) => ({ value, name: value })),
    );
    return [
      { id: "model", name: "Model", category: "model", currentValue: current.model, options: modelChoices },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue: current.thinking,
        options: thinkingChoices,
      },
      { id: "cache", name: "Cache", currentValue: current.cache, options: cacheChoices },
    ].map((option) => ({ type: "select", ...option }));
  }

  function validateConfig(sid: string, key: string, value: string) {
    const option = configOptions(sid).find((opt) => opt.id === key);
    if (!option?.options.some((choice) => choice.value === value)) throw rpcError(-32602, `No ${key} ${value}`);
  }

  function resolveConfig(sid: string) {
    const current = config(sid);
    for (const key of CONFIG_KEYS) validateConfig(sid, key, current[key]);
    return { model: model(sid)!, thinking: current.thinking as ThinkingLevel, cache: current.cache as CacheMode };
  }

  function title(sid: string) {
    const entries = read(sid);
    const start = entries.findLastIndex((line) => line.forked) + 1;
    const firstUser = entries.slice(start).find((line) => line.user);
    return firstUser ? firstLine(extractText(firstUser.user!.content)) || undefined : undefined;
  }

  function fork(sid: string, cursorId?: string) {
    const entries = read(sid);
    const index =
      cursorId == null ? entries.length : entries.findIndex((line, i) => String(i) === cursorId && line.user);
    if (index < 0) throw rpcError(-32602, `No cursor ${cursorId}`);
    const forkedId = randomUUID();
    // Preserve config changes made after the fork point so the fork inherits current settings.
    const trailingConfig = entries.slice(index).filter((line) => CONFIG_KEYS.some((key) => key in line));
    pending.set(forkedId, [...entries.slice(0, index), { forked: sid }, ...trailingConfig]);
    return forkedId;
  }

  function list(cwd?: string) {
    return readdirSync(sessionsDir)
      .flatMap((name) => /^([\w-]+)\.jsonl$/.exec(name)?.[1] ?? [])
      .map((sessionId) => {
        const path = pathFor(sessionId);
        const buf = readFileSync(path);
        const updatedAt = statSync(path).mtime.toISOString();
        return { sessionId, cwd: parseLineAt(buf, 0).began!.cwd, title: extractTitleFromBuffer(buf), updatedAt };
      })
      .filter((session) => !cwd || session.cwd === cwd)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  return {
    create,
    read,
    append,
    header,
    origin,
    history,
    config,
    model,
    configOptions,
    validateConfig,
    resolveConfig,
    title,
    fork,
    list,
  };
}
