import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notice, type TextBlock, type ToolCall, type ToolResult, type ToolSchema } from "./types";

const MAX_OUTPUT_CHARS = 20_000;
const MAX_IMAGE_PIXELS = 2_000;
const DEFAULT_TIMEOUT = 30;
const KILL_GRACE_MS = 1_000;
const MAX_TIMER_MS = 0x7fffffff;

export const BASH_TOOL: ToolSchema = {
  name: "bash",
  description:
    "Run a shell command in the working directory. " +
    `Output is truncated at ${MAX_OUTPUT_CHARS.toLocaleString("en")} characters (full output saved to a file), or returned as an image fit within ${MAX_IMAGE_PIXELS.toLocaleString("en")} pixels. ` +
    `Default timeout is ${DEFAULT_TIMEOUT}s; pass timeout (seconds) for longer or shorter commands.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "Timeout in seconds" },
    },
    required: ["command"],
  },
};

// Any image becomes one WebP that fits every provider, however many images follow it.
const toImage = (raw: Buffer) =>
  new Bun.Image(raw)
    .resize(MAX_IMAGE_PIXELS, MAX_IMAGE_PIXELS, { fit: "inside", withoutEnlargement: true })
    .webp()
    .toBase64()
    .catch(() => undefined);

function truncateOutput(text: string, path: string) {
  const cut = text.lastIndexOf("\n", MAX_OUTPUT_CHARS);
  // Avoid splitting a UTF-16 surrogate pair at the slice boundary.
  const shown = text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS).replace(/[\ud800-\udbff]$/, "");
  const omitted = (text.length - shown.length).toLocaleString("en");
  return `${shown}\n${notice(`${omitted} characters not shown, full output in ${path}`)}`;
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

  let truncated = false;
  try {
    const [status] = await once(child, "exit");
    const raw = readFileSync(outPath);
    const isText = isUtf8(raw);
    const image = isText ? undefined : await toImage(raw);
    const text = raw.toString("utf8").trimEnd();
    truncated = isText && text.length > MAX_OUTPUT_CHARS;

    const suffix = timedOut ? notice(`timeout after ${timeout}s`) : "";
    const withSuffix = (body: string): TextBlock => ({
      type: "text",
      text: [body, suffix].filter(Boolean).join("\n"),
    });

    const content: ToolResult["content"] = isText
      ? [withSuffix(truncated ? truncateOutput(text, outPath) : text)]
      : image
        ? [{ type: "image", data: image, mimeType: "image/webp" }, ...(suffix ? [withSuffix("")] : [])]
        : [withSuffix(notice("output is of unsupported format"))];

    return { content, failed: stopped || status !== 0 || !(isText || image) };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    signal.removeEventListener("abort", stop);
    // Reap any grandchildren left in the process group after cancel/timeout.
    if (stopped) killGroup("SIGKILL");
    closeSync(outFd);
    if (!truncated) rmSync(outPath);
  }
}
