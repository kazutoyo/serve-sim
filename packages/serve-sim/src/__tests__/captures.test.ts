import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, dirname, join, sep } from "path";
import {
  AlreadyRecordingError,
  NotRecordingError,
  captureFilename,
  readRecordingState,
  recordVideoArgs,
  recordingStateFile,
  recordingStatus,
  resolveCapturesDir,
  screenshotArgs,
  startRecording,
  stopRecording,
  takeScreenshot,
  writeRecordingState,
  type RecordingState,
} from "../captures";

describe("resolveCapturesDir", () => {
  test("defaults to ./serve-sim-captures under cwd", () => {
    expect(resolveCapturesDir(undefined)).toBe(join(process.cwd(), "serve-sim-captures"));
  });

  test("resolves a relative dir against cwd", () => {
    expect(resolveCapturesDir("out/caps")).toBe(join(process.cwd(), "out", "caps"));
  });

  test("keeps an absolute dir as-is", () => {
    const abs = `${sep}tmp${sep}my-captures`;
    expect(resolveCapturesDir(abs)).toBe(abs);
    expect(isAbsolute(resolveCapturesDir(abs))).toBe(true);
  });
});

describe("captureFilename", () => {
  const date = new Date(2026, 5, 6, 7, 1, 57, 42); // local 2026-06-06 07:01:57.042

  test("screenshot name embeds a sortable timestamp and .png", () => {
    expect(captureFilename("screenshot", date)).toBe("screenshot-20260606-070157-042.png");
  });

  test("recording name uses .mp4", () => {
    expect(captureFilename("recording", date)).toBe("recording-20260606-070157-042.mp4");
  });
});

describe("simctl argv builders", () => {
  test("screenshotArgs", () => {
    expect(screenshotArgs("ABC-123", "/tmp/x.png")).toEqual([
      "simctl", "io", "ABC-123", "screenshot", "/tmp/x.png",
    ]);
  });

  test("recordVideoArgs uses h264", () => {
    expect(recordVideoArgs("ABC-123", "/tmp/x.mp4")).toEqual([
      "simctl", "io", "ABC-123", "recordVideo", "--codec", "h264", "/tmp/x.mp4",
    ]);
  });
});

describe("recording state file", () => {
  test("recordingStateFile path is per-udid under the state dir", () => {
    expect(recordingStateFile("ABC-123")).toMatch(/serve-sim[/\\]recordings[/\\]ABC-123\.json$/);
  });

  test("round-trips state for a live pid", () => {
    const state: RecordingState = {
      pid: process.pid, // this test process is definitely alive
      path: "/tmp/recording-x.mp4",
      startedAt: 1717650000000,
    };
    writeRecordingState("TEST-LIVE", state);
    try {
      expect(readRecordingState("TEST-LIVE")).toEqual(state);
    } finally {
      rmSync(recordingStateFile("TEST-LIVE"), { force: true });
    }
  });

  test("returns null and removes the file when the pid is dead", () => {
    const file = recordingStateFile("TEST-DEAD");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: 999999999, path: "/tmp/x.mp4", startedAt: 0 }));
    expect(readRecordingState("TEST-DEAD")).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test("returns null for a missing file", () => {
    expect(readRecordingState("TEST-MISSING")).toBeNull();
  });
});

describe("takeScreenshot", () => {
  test("rejects with simctl's error for an invalid device", async () => {
    await expect(takeScreenshot("NOT-A-REAL-UDID", mkdtempSync(join(tmpdir(), "serve-sim-shot-")))).rejects.toThrow(/Invalid device|device|error/i);
  });
});

describe("start/stop/status recording", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-captures-test-"));
  const UDID = "TEST-REC-1";
  const fakeCmd = { command: "/bin/sleep", args: ["100"] }; // stands in for xcrun simctl

  test("startRecording spawns, registers state, and status reports it", async () => {
    const started = await startRecording(UDID, dir, { cmd: fakeCmd });
    try {
      expect(started.path.startsWith(dir)).toBe(true);
      expect(started.path.endsWith(".mp4")).toBe(true);
      const status = recordingStatus(UDID);
      expect(status.recording).toBe(true);
      expect(status.path).toBe(started.path);
    } finally {
      await stopRecording(UDID).catch(() => {});
    }
  });

  test("double start throws AlreadyRecordingError", async () => {
    await startRecording(UDID, dir, { cmd: fakeCmd });
    try {
      await expect(startRecording(UDID, dir, { cmd: fakeCmd })).rejects.toBeInstanceOf(
        AlreadyRecordingError,
      );
    } finally {
      await stopRecording(UDID);
    }
  });

  test("stopRecording kills the process, clears state, returns the path", async () => {
    const started = await startRecording(UDID, dir, { cmd: fakeCmd });
    const path = await stopRecording(UDID);
    expect(path).toBe(started.path);
    expect(recordingStatus(UDID).recording).toBe(false);
    expect(readRecordingState(UDID)).toBeNull();
  });

  test("stopRecording with no active recording throws NotRecordingError", async () => {
    await expect(stopRecording("TEST-NONE")).rejects.toBeInstanceOf(NotRecordingError);
  });

  test("startRecording surfaces an instantly-failing command as an error", async () => {
    await expect(
      startRecording("TEST-FAIL", dir, { cmd: { command: "/usr/bin/false", args: [] } }),
    ).rejects.toThrow();
    expect(recordingStatus("TEST-FAIL").recording).toBe(false);
  });
});

describe("stopRecording timeout/zombie fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-captures-hung-"));
  const UDID2 = "TEST-HUNG";
  // A recorder that ignores SIGINT — simulates a hung simctl process.
  const hungCmd = { command: "/bin/sh", args: ["-c", "trap '' INT; sleep 100"] };

  test("force-kills and clears registry when recorder ignores SIGINT", async () => {
    const started = await startRecording(UDID2, dir, { cmd: hungCmd });
    const pid = started.pid;

    await expect(stopRecording(UDID2, { timeoutMs: 1_000 })).rejects.toThrow(/did not exit/);

    // Registry must be cleared — device must not be permanently locked.
    expect(readRecordingState(UDID2)).toBeNull();

    // The process must actually be dead within ~2s of the SIGKILL.
    const deadline = Date.now() + 2_000;
    let dead = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise<void>((r) => setTimeout(r, 50));
      } catch {
        dead = true;
        break;
      }
    }
    expect(dead).toBe(true);
  }, 10_000);
});
