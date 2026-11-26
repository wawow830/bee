import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notice, type TextBlock, type ToolCall, type ToolResult, type ToolSchema } from "./types";

const MAX_CHARS = 20_000;
const MAX_PIXELS = 2_000;
const DEFAULT_TIMEOUT = 30;
const KILL_GRACE_MS = 1_000;
const MAX_TIMER_MS = 0x7fffffff;

export const BASH_TOOL: ToolSchema = {
  name: "bash",
  description:
    "Run a shell command in the working directory. " +
    "Output is text or image. " +
    `Limits are ${MAX_CHARS} chars and ${MAX_PIXELS}px. ` +
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

const IMAGE_FORMATS = ["png", "jpeg", "gif", "webp"];

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

  let saved = false;
  try {
    const [status] = await once(child, "exit");
    const raw = readFileSync(outPath);
    const text = raw.toString("utf8").trimEnd();
    const image = await new Bun.Image(raw).metadata().catch(() => undefined);
    const format =
      isUtf8(raw) && text.length <= MAX_CHARS
        ? "text"
        : image && IMAGE_FORMATS.includes(image.format) && Math.max(image.width, image.height) <= MAX_PIXELS
          ? `image/${image.format}`
          : undefined;
    saved = !format;

    const suffix = timedOut ? notice(`timeout after ${timeout}s`) : "";
    const withSuffix = (body: string): TextBlock => ({
      type: "text",
      text: [body, suffix].filter(Boolean).join("\n"),
    });

    const content: ToolResult["content"] =
      format === "text"
        ? [withSuffix(text)]
        : format
          ? [{ type: "image", data: raw.toString("base64"), mimeType: format }, ...(suffix ? [withSuffix("")] : [])]
          : [withSuffix(notice(`output saved to ${outPath}`))];

    return { content, failed: stopped || status !== 0 };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    signal.removeEventListener("abort", stop);
    // Reap any grandchildren left in the process group after cancel/timeout.
    if (stopped) killGroup("SIGKILL");
    closeSync(outFd);
    if (!saved) rmSync(outPath);
  }
}
