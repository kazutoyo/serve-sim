import { execFile, spawn } from "child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { STATE_DIR } from "./state";

export type CaptureKind = "screenshot" | "recording";

/** Resolve the captures directory; default `./serve-sim-captures` under cwd. */
export function resolveCapturesDir(dir: string | undefined): string {
  return resolve(dir ?? "serve-sim-captures");
}

/** Server-generated capture filename: sortable local timestamp, no client input. */
export function captureFilename(kind: CaptureKind, date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}` +
    `-${p(date.getMilliseconds(), 3)}`;
  return `${kind}-${stamp}.${kind === "screenshot" ? "png" : "mp4"}`;
}

/** argv for `xcrun <...>` — kept pure for tests. */
export function screenshotArgs(udid: string, outPath: string): string[] {
  return ["simctl", "io", udid, "screenshot", outPath];
}

export function recordVideoArgs(udid: string, outPath: string): string[] {
  return ["simctl", "io", udid, "recordVideo", "--codec", "h264", outPath];
}

export interface RecordingState {
  /** pid of the detached `simctl io recordVideo` process. */
  pid: number;
  /** Absolute path of the MP4 being written. */
  path: string;
  /** Epoch ms when the recording started. */
  startedAt: number;
}

/** Per-device recording registry: `/tmp/serve-sim/recordings/<udid>.json`. */
export function recordingStateFile(udid: string): string {
  return join(STATE_DIR, "recordings", `${udid}.json`);
}

export function writeRecordingState(udid: string, state: RecordingState): void {
  const file = recordingStateFile(udid);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

/**
 * Read the active recording for a device. Returns null (and removes the
 * stale file) when the recorder process is gone — e.g. the simulator was
 * shut down mid-recording, which makes simctl exit on its own.
 */
export function readRecordingState(udid: string): RecordingState | null {
  const file = recordingStateFile(udid);
  let state: RecordingState;
  try {
    state = JSON.parse(readFileSync(file, "utf-8")) as RecordingState;
  } catch {
    return null;
  }
  try {
    process.kill(state.pid, 0);
  } catch {
    try { unlinkSync(file); } catch {}
    return null;
  }
  return state;
}

export class AlreadyRecordingError extends Error {
  constructor(public readonly path: string) {
    super(`Already recording to ${path}`);
    this.name = "AlreadyRecordingError";
  }
}

export class NotRecordingError extends Error {
  constructor() {
    super("No active recording for this device");
    this.name = "NotRecordingError";
  }
}

interface SpawnCmd {
  command: string;
  args: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Take a screenshot via `xcrun simctl io <udid> screenshot`. Returns the
 * absolute path of the PNG. Rejects with simctl's stderr on failure.
 */
export function takeScreenshot(udid: string, dir: string, outPath?: string): Promise<string> {
  const path = outPath ?? join(dir, captureFilename("screenshot", new Date()));
  mkdirSync(dirname(path), { recursive: true });
  return new Promise((resolvePromise, reject) => {
    execFile("xcrun", screenshotArgs(udid, path), { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.toString().trim() || err.message));
      else resolvePromise(path);
    });
  });
}

/**
 * Start a detached `simctl io recordVideo` for the device. The recorder
 * outlives this process; its pid is registered in the recording state file so
 * any later serve-sim invocation (CLI or middleware) can stop it.
 * `opts.cmd` overrides the spawned command for tests.
 */
export async function startRecording(
  udid: string,
  dir: string,
  opts?: { cmd?: SpawnCmd },
): Promise<RecordingState> {
  const existing = readRecordingState(udid);
  if (existing) throw new AlreadyRecordingError(existing.path);

  const path = join(dir, captureFilename("recording", new Date()));
  mkdirSync(dirname(path), { recursive: true });
  const cmd = opts?.cmd ?? { command: "xcrun", args: recordVideoArgs(udid, path) };

  const child = spawn(cmd.command, cmd.args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

  // Catch fast failures (bad udid, device not booted): a healthy recordVideo
  // keeps running, so an exit within the grace window is an error.
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const result = await Promise.race([exited, sleep(500).then(() => "alive" as const)]);
  if (result !== "alive") {
    throw new Error(stderr.trim() || `recordVideo exited immediately (code ${result})`);
  }
  child.stderr?.destroy(); // detach fully; nothing reads it after the grace window
  child.unref();

  const state: RecordingState = { pid: child.pid!, path, startedAt: Date.now() };
  writeRecordingState(udid, state);
  return state;
}

/**
 * Stop the active recording: SIGINT the recorder (simctl finalizes the moov
 * atom) and wait for it to exit. Returns the MP4 path.
 */
export async function stopRecording(udid: string): Promise<string> {
  const state = readRecordingState(udid);
  if (!state) throw new NotRecordingError();
  try {
    process.kill(state.pid, "SIGINT");
  } catch {
    // Died between read and kill — state already valid to clear.
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
    } catch {
      try { unlinkSync(recordingStateFile(udid)); } catch {}
      return state.path;
    }
    await sleep(100);
  }
  throw new Error(`Recorder pid ${state.pid} did not exit within 15s`);
}

export interface RecordingStatus {
  recording: boolean;
  path?: string;
  startedAt?: number;
}

export function recordingStatus(udid: string): RecordingStatus {
  const state = readRecordingState(udid);
  return state
    ? { recording: true, path: state.path, startedAt: state.startedAt }
    : { recording: false };
}
