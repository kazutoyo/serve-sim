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
