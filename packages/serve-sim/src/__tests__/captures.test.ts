import { describe, expect, test } from "bun:test";
import { isAbsolute, join, sep } from "path";
import {
  captureFilename,
  recordVideoArgs,
  resolveCapturesDir,
  screenshotArgs,
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
