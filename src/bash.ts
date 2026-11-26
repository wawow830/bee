import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notice, type ImageBlock, type TextBlock, type ToolCall, type ToolResult, type ToolSchema } from "./types";

const MAX_OUTPUT_CHARS = 20_000;
const MAX_IMAGE_PIXELS = 2_000;
const DEFAULT_TIMEOUT = 30;
const KILL_GRACE_MS = 1_000;
const MAX_TIMER_MS = 0x7fffffff;

export const BASH_TOOL: ToolSchema = {
  name: "bash",
  description:
    "Run a shell command in the working directory. " +
    "Output is returned as text or image. " +
    `Default timeout is ${DEFAULT_TIMEOUT}s.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "Timeout in seconds" },
    },
    required: ["command"],
  },
};

// The image formats every provider accepts.
const IMAGE_FORMATS = ["png", "jpeg", "gif", "webp"];

// Output as the model sees it, and whether that is all of it.
type Read = [TextBlock | ImageBlock, boolean];

const withheld = (why: string, path: string, shown = ""): Read => [
  { type: "text", text: [shown, notice(`${why}, full output in ${path}`)].filter(Boolean).join("\n") },
  false,
];

function readText(raw: Buffer, path: string): Read {
  const text = raw.toString("utf8").trimEnd();
  if (text.length <= MAX_OUTPUT_CHARS) return [{ type: "text", text }, true];
  const cut = text.lastIndexOf("\n", MAX_OUTPUT_CHARS);
  // Avoid splitting a UTF-16 surrogate pair at the slice boundary.
  const shown = text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS).replace(/[\ud800-\udbff]$/, "");
  const omitted = (text.length - shown.length).toLocaleString("en");
  return withheld(`${omitted} characters not shown`, path, shown);
}

async function readImage(raw: Buffer, path: string): Promise<Read> {
  const image = await new Bun.Image(raw).metadata().catch(() => undefined);
  if (!image || !IMAGE_FORMATS.includes(image.format)) return withheld("output is of unsupported format", path);
  const { width, height, format } = image;
  const max = MAX_IMAGE_PIXELS.toLocaleString("en");
  if (Math.max(width, height) > MAX_IMAGE_PIXELS)
    return withheld(`image is ${width}×${height}, over ${max} pixels`, path);
  return [{ type: "image", data: raw.toString("base64"), mimeType: `image/${format}` }, true];
}

export async function runBash(cwd: string, call: ToolCall, signal: AbortSignal) {
  const { command, timeout = DEFAULT_TIMEOUT } = call.arguments;
  if (call.name !== BASH_TOOL.name) throw new Error("tool does not exist");
  if (typeof command !== "string") throw new Error("command must be a string");
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    throw new Error("timeout must be a positive number");
  if (!existsSync(cwd)) throw new Error("working directory does not exist");

  // Redirect stdout/stderr to a file so detached child processes don't keep pipes open past shell exit.
  const outPath = join(tmpdir(), `bee-${randomUUID()}`);
  const outFd = openSync(outPath, "w");
  const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", outFd, outFd], detached: true });

  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {}
  };

  let timedOut = false;
  let stopped = false;
  let graceTimer: Timer | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    killGroup("SIGINT");
    graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  };

  const timeoutTimer = setTimeout(
    () => {
      timedOut = true;
      stop();
    },
    Math.min(timeout * 1000, MAX_TIMER_MS),
  );
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();

  let whole = true;
  try {
    const [status] = await once(child, "exit");
    const raw = readFileSync(outPath);
    let block: TextBlock | ImageBlock;
    [block, whole] = isUtf8(raw) ? readText(raw, outPath) : await readImage(raw, outPath);

    const suffix = timedOut ? notice(`timeout after ${timeout}s`) : "";
    const content: ToolResult["content"] =
      block.type === "text"
        ? [{ type: "text", text: [block.text, suffix].filter(Boolean).join("\n") }]
        : [block, ...(suffix ? [{ type: "text" as const, text: suffix }] : [])];

    return { content, failed: stopped || status !== 0 };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    signal.removeEventListener("abort", stop);
    // Reap any grandchildren left in the process group after cancel/timeout.
    if (stopped) killGroup("SIGKILL");
    closeSync(outFd);
    if (whole) rmSync(outPath);
  }
}
