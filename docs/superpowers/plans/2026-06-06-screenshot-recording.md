# Screenshot & Screen Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add screenshot + screen-recording to serve-sim, usable from the web UI toolbar (clipboard/download) and the CLI (`serve-sim screenshot`, `serve-sim record start|stop|status`), with all captures saved to a configurable host directory.

**Architecture:** A shared `captures.ts` module wraps `xcrun simctl io <udid> screenshot|recordVideo`. Recording is a detached simctl process tracked by a pid state file under `/tmp/serve-sim/recordings/<udid>.json` (same pattern as the camera helper's pid files), so a recording started from the web UI can be stopped from the CLI and vice versa. The middleware adds thin HTTP endpoints over the module for the browser; the CLI calls the module directly.

**Tech Stack:** Node (child_process, fs), Connect-style middleware (`src/middleware.ts`), commander CLI (`src/index.ts`), React/Preact client (`src/client/`), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-06-screenshot-recording-design.md`

**Conventions reminders:**
- All new TS files kebab-case. Tests live in `packages/serve-sim/src/__tests__/`.
- Test runner is `bun:test` (NOT vitest): `cd packages/serve-sim && bun test src/__tests__/<file>.test.ts`.
- Avoid low-opacity icons (project CLAUDE.md).
- Commit message format: `<type>: <emoji> <subject>` (e.g. `feat: ✨ ...`).
- Run from repo root unless noted. `bun` is available.

---

### Task 1: captures module — pure helpers (dir, filename, argv builders)

**Files:**
- Create: `packages/serve-sim/src/captures.ts`
- Test: `packages/serve-sim/src/__tests__/captures.test.ts`

- [ ] **Step 1: Write failing tests for the pure helpers**

```typescript
// packages/serve-sim/src/__tests__/captures.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/serve-sim && bun test src/__tests__/captures.test.ts`
Expected: FAIL — `Cannot find module '../captures'` (or missing exports).

- [ ] **Step 3: Implement the pure helpers**

```typescript
// packages/serve-sim/src/captures.ts
import { resolve } from "path";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/serve-sim && bun test src/__tests__/captures.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/serve-sim/src/captures.ts packages/serve-sim/src/__tests__/captures.test.ts
git commit -m "feat: ✨ add captures module pure helpers (dir, filename, simctl argv)"
```

---

### Task 2: captures module — recording state file with pid liveness

**Files:**
- Modify: `packages/serve-sim/src/captures.ts`
- Test: `packages/serve-sim/src/__tests__/captures.test.ts` (append)

The recording registry mirrors the simcam pid-file pattern (`src/index.ts:1183-1241`): a JSON file per device whose pid is checked with `process.kill(pid, 0)`; stale files are removed on read.

- [ ] **Step 1: Write failing tests**

Append to `captures.test.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname } from "path"; // merge with Task 1's `path` import line
import {
  readRecordingState,
  recordingStateFile,
  writeRecordingState,
  type RecordingState,
} from "../captures";

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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd packages/serve-sim && bun test src/__tests__/captures.test.ts`
Expected: FAIL — missing exports `recordingStateFile` etc.

- [ ] **Step 3: Implement state read/write**

Append to `captures.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { STATE_DIR } from "./state";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/serve-sim && bun test src/__tests__/captures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/serve-sim/src/captures.ts packages/serve-sim/src/__tests__/captures.test.ts
git commit -m "feat: ✨ recording state registry with pid liveness"
```

---

### Task 3: captures module — start/stop/status with injectable command

**Files:**
- Modify: `packages/serve-sim/src/captures.ts`
- Test: `packages/serve-sim/src/__tests__/captures.test.ts` (append)

`startRecording` spawns a **detached** process (so it outlives the CLI/preview server) and verifies it didn't die instantly (catches "Invalid device" errors fast). `stopRecording` SIGINTs the pid from the state file and polls until exit — simctl finalizes the MP4's moov atom on SIGINT. Tests inject `/bin/sleep 100` instead of simctl.

- [ ] **Step 1: Write failing tests**

Append to `captures.test.ts`:

```typescript
import {
  AlreadyRecordingError,
  NotRecordingError,
  recordingStatus,
  startRecording,
  stopRecording,
} from "../captures";

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
      expect(startRecording(UDID, dir, { cmd: fakeCmd })).rejects.toBeInstanceOf(
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
    expect(stopRecording("TEST-NONE")).rejects.toBeInstanceOf(NotRecordingError);
  });

  test("startRecording surfaces an instantly-failing command as an error", async () => {
    expect(
      startRecording("TEST-FAIL", dir, { cmd: { command: "/usr/bin/false", args: [] } }),
    ).rejects.toThrow();
    expect(recordingStatus("TEST-FAIL").recording).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd packages/serve-sim && bun test src/__tests__/captures.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement start/stop/status + takeScreenshot**

Append to `captures.ts`:

```typescript
import { execFile, spawn } from "child_process";

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
```

Consolidate the imports at the top of `captures.ts` (single `fs`, `path`, `child_process` import lines — no duplicate import statements from Tasks 1-3).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/serve-sim && bun test src/__tests__/captures.test.ts`
Expected: PASS (all tests, including Tasks 1-2 ones).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add packages/serve-sim/src/captures.ts packages/serve-sim/src/__tests__/captures.test.ts
git commit -m "feat: ✨ start/stop/status recording + takeScreenshot in captures module"
```

---

### Task 4: middleware endpoints

**Files:**
- Modify: `packages/serve-sim/src/middleware.ts`
- Test: `packages/serve-sim/src/__tests__/capture-endpoints.test.ts`

Add five routes following the `/grid/api/*` style (`middleware.ts:844-932`). Happy paths that need a booted simulator are covered by e2e (Task 8); these tests cover validation/error paths and file serving, no simulator needed.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/serve-sim/src/__tests__/capture-endpoints.test.ts
import { describe, expect, test } from "bun:test";
import { createServer } from "http";
import { mkdtempSync, writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { simMiddleware } from "../middleware";

const CAPTURES_DIR = mkdtempSync(join(tmpdir(), "serve-sim-captures-ep-"));

async function withServer<T>(fn: (origin: string) => Promise<T>): Promise<T> {
  const handler = simMiddleware({ basePath: "/", capturesDir: CAPTURES_DIR });
  const server = createServer((req, res) => {
    handler(req, res, () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end("Not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("capture endpoints — validation", () => {
  test("POST /api/screenshot with malformed udid → 400", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/api/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ udid: "../etc/passwd" }),
      });
      expect(r.status).toBe(400);
    });
  });

  test("POST /api/record/stop with no active recording → 404", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/api/record/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ udid: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(r.status).toBe(404);
    });
  });

  test("GET /api/record/status with explicit udid → recording:false", async () => {
    await withServer(async (origin) => {
      const r = await fetch(
        `${origin}/api/record/status?udid=00000000-0000-0000-0000-000000000000`,
      );
      expect(r.status).toBe(200);
      const body = await r.json() as { recording: boolean };
      expect(body.recording).toBe(false);
    });
  });
});

describe("GET /api/captures/<file>", () => {
  test("serves an existing capture with the right content-type", async () => {
    writeFileSync(join(CAPTURES_DIR, "screenshot-20260606-000000-000.png"), "fakepng");
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/api/captures/screenshot-20260606-000000-000.png`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(await r.text()).toBe("fakepng");
    });
  });

  test("rejects names that aren't server-generated capture names", async () => {
    await withServer(async (origin) => {
      for (const bad of ["..%2F..%2Fetc%2Fpasswd", "evil.png", "screenshot-x.sh"]) {
        const r = await fetch(`${origin}/api/captures/${bad}`);
        expect([400, 404]).toContain(r.status);
      }
    });
  });

  test("404 for a well-formed but missing file", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/api/captures/screenshot-19990101-000000-000.png`);
      expect(r.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/serve-sim && bun test src/__tests__/capture-endpoints.test.ts`
Expected: FAIL — `capturesDir` is not a known option / routes 404.

- [ ] **Step 3: Implement the routes**

In `middleware.ts`:

a. Add to imports: `import { AlreadyRecordingError, NotRecordingError, recordingStatus, resolveCapturesDir, startRecording, stopRecording, takeScreenshot } from "./captures";` and `import { createReadStream, existsSync as fsExistsSync } from "fs";` (merge with existing fs imports — the file already imports from "fs"; extend that line) and `basename, join` from "path" (extend existing import).

b. Add to `SimMiddlewareOptions` (after `execToken`):

```typescript
  /**
   * Directory where screenshots/recordings are written.
   * Default: `./serve-sim-captures` under the server's cwd.
   */
  capturesDir?: string;
```

c. Inside `simMiddleware()` before the returned handler:

```typescript
  const capturesDir = resolveCapturesDir(options?.capturesDir);
  const UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
  // Only names captureFilename() generates — keeps /api/captures from serving
  // anything else out of the directory.
  const CAPTURE_FILE_RE = /^(screenshot|recording)-\d{8}-\d{6}-\d{3}\.(png|mp4)$/;
```

d. Add a small body-reading helper near `isJsonContentType` (module scope):

```typescript
function readJsonBody(req: SimReq): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += typeof chunk === "string" ? chunk : chunk.toString();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body) as Record<string, unknown>); } catch { resolve({}); }
    });
  });
}
```

e. Add routes inside the handler, after the `/grid/api/start` block (~line 932). A shared resolver picks the target udid: explicit body/query `udid` (validated) → `selectedDevice` → first running helper state:

```typescript
    // Resolve the device for capture endpoints: explicit udid (body/query),
    // else the device selected for this preview, else the first live helper.
    const resolveCaptureUdid = (explicit: unknown): { udid?: string; error?: string } => {
      if (typeof explicit === "string" && explicit.length > 0) {
        if (!UDID_RE.test(explicit)) return { error: "Invalid udid" };
        return { udid: explicit };
      }
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) return { error: "No serve-sim device" };
      return { udid: state.device };
    };
    const sendJson = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
    };
    const captureUrl = (filePath: string) =>
      `${base}/api/captures/${encodeURIComponent(basename(filePath))}`;

    // POST /api/screenshot — capture a PNG via `simctl io screenshot`.
    if (url === base + "/api/screenshot" && req.method === "POST") {
      (async () => {
        const body = await readJsonBody(req);
        const target = resolveCaptureUdid(body.udid);
        if (!target.udid) {
          sendJson(target.error === "Invalid udid" ? 400 : 404, { ok: false, error: target.error });
          return;
        }
        try {
          const path = await takeScreenshot(target.udid, capturesDir);
          sendJson(200, { ok: true, path, url: captureUrl(path) });
        } catch (err) {
          sendJson(500, { ok: false, error: err instanceof Error ? err.message : "screenshot failed" });
        }
      })();
      return;
    }

    // POST /api/record/start — spawn a detached `simctl io recordVideo`.
    if (url === base + "/api/record/start" && req.method === "POST") {
      (async () => {
        const body = await readJsonBody(req);
        const target = resolveCaptureUdid(body.udid);
        if (!target.udid) {
          sendJson(target.error === "Invalid udid" ? 400 : 404, { ok: false, error: target.error });
          return;
        }
        try {
          const state = await startRecording(target.udid, capturesDir);
          sendJson(200, { ok: true, path: state.path, startedAt: state.startedAt });
        } catch (err) {
          if (err instanceof AlreadyRecordingError) {
            sendJson(409, { ok: false, error: err.message, path: err.path });
            return;
          }
          sendJson(500, { ok: false, error: err instanceof Error ? err.message : "record failed" });
        }
      })();
      return;
    }

    // POST /api/record/stop — SIGINT the recorder and return the MP4.
    if (url === base + "/api/record/stop" && req.method === "POST") {
      (async () => {
        const body = await readJsonBody(req);
        const target = resolveCaptureUdid(body.udid);
        if (!target.udid) {
          sendJson(target.error === "Invalid udid" ? 400 : 404, { ok: false, error: target.error });
          return;
        }
        try {
          const path = await stopRecording(target.udid);
          sendJson(200, { ok: true, path, url: captureUrl(path) });
        } catch (err) {
          if (err instanceof NotRecordingError) {
            sendJson(404, { ok: false, error: err.message });
            return;
          }
          sendJson(500, { ok: false, error: err instanceof Error ? err.message : "stop failed" });
        }
      })();
      return;
    }

    // GET /api/record/status — `?udid=` optional.
    if (url === base + "/api/record/status") {
      const queryUdid = new URLSearchParams(qIndex === -1 ? "" : rawUrl.slice(qIndex + 1)).get("udid");
      const target = resolveCaptureUdid(queryUdid ?? undefined);
      if (!target.udid) {
        sendJson(target.error === "Invalid udid" ? 400 : 404, { ok: false, error: target.error });
        return;
      }
      sendJson(200, recordingStatus(target.udid));
      return;
    }

    // GET /api/captures/<file> — serve a previously captured file. Only
    // server-generated names pass CAPTURE_FILE_RE, so no traversal surface.
    if (url.startsWith(base + "/api/captures/")) {
      const name = decodeURIComponent(url.slice((base + "/api/captures/").length));
      if (!CAPTURE_FILE_RE.test(name)) {
        sendJson(400, { ok: false, error: "Invalid capture name" });
        return;
      }
      const filePath = join(capturesDir, name);
      if (!fsExistsSync(filePath)) {
        sendJson(404, { ok: false, error: "Not found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": name.endsWith(".png") ? "image/png" : "video/mp4",
        "Cache-Control": "no-store",
      });
      createReadStream(filePath).pipe(res);
      return;
    }
```

Note: `resolveCaptureUdid`, `sendJson`, `captureUrl` are defined inside the request handler (they capture `res`/`selectedDevice`), placed right before the screenshot route. If `selectServeSimState`/`readServeSimStates` are imported under different local names in middleware.ts, match the existing names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/serve-sim && bun test src/__tests__/capture-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full middleware-adjacent suite + typecheck, then commit**

Run: `cd packages/serve-sim && bun test src/__tests__/exec-auth.test.ts src/__tests__/middleware-selection.test.ts src/__tests__/capture-endpoints.test.ts && cd ../.. && bun run typecheck`
Expected: PASS.

```bash
git add packages/serve-sim/src/middleware.ts packages/serve-sim/src/__tests__/capture-endpoints.test.ts
git commit -m "feat: ✨ screenshot/record HTTP endpoints in preview middleware"
```

---

### Task 5: CLI commands + --captures-dir wiring

**Files:**
- Modify: `packages/serve-sim/src/index.ts`

CLI talks to the captures module directly (no preview server needed). Device resolution mirrors `tap`/`gesture`: `-d` udid, else `readState()`.

- [ ] **Step 1: Implement command handlers**

In `index.ts`, near the other command functions (e.g. after `memoryWarning`):

```typescript
async function screenshotCommand(opts: { device?: string; output?: string; dir?: string }) {
  const { resolveCapturesDir, takeScreenshot } = await import("./captures");
  const udid = opts.device ?? readState()?.device;
  if (!udid) {
    console.error("No device. Pass -d <udid> or start serve-sim first.");
    process.exit(1);
  }
  try {
    const path = await takeScreenshot(udid, resolveCapturesDir(opts.dir), opts.output);
    console.log(path);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function recordCommand(verb: string, opts: { device?: string; dir?: string }) {
  const captures = await import("./captures");
  const udid = opts.device ?? readState()?.device;
  if (!udid) {
    console.error("No device. Pass -d <udid> or start serve-sim first.");
    process.exit(1);
  }
  try {
    if (verb === "start") {
      const state = await captures.startRecording(udid, captures.resolveCapturesDir(opts.dir));
      console.log(state.path);
    } else if (verb === "stop") {
      const path = await captures.stopRecording(udid);
      console.log(path);
    } else if (verb === "status") {
      console.log(JSON.stringify(captures.recordingStatus(udid)));
    } else {
      console.error("Usage: serve-sim record <start|stop|status> [-d udid] [--dir <dir>]");
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof captures.AlreadyRecordingError) {
      console.error(err.message);
      process.exit(2);
    }
    if (err instanceof captures.NotRecordingError) {
      console.error(err.message);
      process.exit(3);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
```

Register the commands after the `memory-warning` registration (~line 1982):

```typescript
program
  .command("screenshot")
  .description("Save a screenshot of the simulator (prints the saved path)")
  .option(...deviceOpt)
  .option("-o, --output <path>", "Exact output path (default: <captures-dir>/<timestamp>.png)")
  .option("--dir <dir>", "Captures directory (default: ./serve-sim-captures)")
  .action((opts) => screenshotCommand(opts));

program
  .command("record")
  .description("Record the simulator screen to MP4 (start|stop|status)")
  .argument("<verb>", "start | stop | status")
  .option(...deviceOpt)
  .option("--dir <dir>", "Captures directory (default: ./serve-sim-captures)")
  .action((verb: string, opts) => recordCommand(verb, opts));
```

- [ ] **Step 2: Wire `--captures-dir` through the default serve command**

Add the option to the default command (next to `--host`, ~line 1884):

```typescript
  .option("--captures-dir <dir>", "Directory for screenshots/recordings (default: ./serve-sim-captures)")
```

Thread it through: the `.action` handler passes `opts.capturesDir` to `serve(...)`; change `serve()`'s signature to `async function serve(servePort: number, devices: string[], portExplicit: boolean, host: string, capturesDir?: string)` and pass it into the middleware at `index.ts:1812`:

```typescript
  const middleware = simMiddleware({ basePath: "/", device: targetDevice, capturesDir });
```

- [ ] **Step 3: Verify by hand (no booted sim needed for the error paths)**

Run: `cd packages/serve-sim && bun run src/index.ts screenshot -d 00000000-0000-0000-0000-000000000000`
Expected: exits non-zero with a simctl "Invalid device" error printed to stderr.

Run: `cd packages/serve-sim && bun run src/index.ts record status -d 00000000-0000-0000-0000-000000000000`
Expected: prints `{"recording":false}`.

Run: `cd packages/serve-sim && bun run src/index.ts --help`
Expected: `screenshot` and `record` listed.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add packages/serve-sim/src/index.ts
git commit -m "feat: ✨ serve-sim screenshot / record CLI commands + --captures-dir"
```

---

### Task 6: client capture API + clipboard/download helpers

**Files:**
- Create: `packages/serve-sim/src/client/utils/captures.ts`

Pure-browser helpers; no tests in the repo cover client utils with DOM APIs (no jsdom setup), so this is verified through Task 8's e2e. Keep the module small and dumb.

- [ ] **Step 1: Implement the client API wrapper + clipboard/download**

```typescript
// packages/serve-sim/src/client/utils/captures.ts
import { simEndpoint } from "./sim-endpoint";

export interface CaptureResult {
  ok: boolean;
  path?: string;
  url?: string;
  startedAt?: number;
  error?: string;
}

export interface RecordingStatusResult {
  recording: boolean;
  path?: string;
  startedAt?: number;
}

async function postJson(path: string, body: object): Promise<CaptureResult> {
  const res = await fetch(simEndpoint(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as CaptureResult;
}

export const takeScreenshot = (udid: string) => postJson("api/screenshot", { udid });
export const startRecording = (udid: string) => postJson("api/record/start", { udid });
export const stopRecording = (udid: string) => postJson("api/record/stop", { udid });

export async function recordingStatus(udid: string): Promise<RecordingStatusResult> {
  const res = await fetch(simEndpoint(`api/record/status?udid=${encodeURIComponent(udid)}`));
  return (await res.json()) as RecordingStatusResult;
}

/**
 * Copy the PNG at `url` to the clipboard. Returns false when the Clipboard
 * API is unavailable (non-secure context — e.g. the preview opened via a LAN
 * IP) or the write fails; callers fall back to a download.
 */
export async function copyImageToClipboard(url: string): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return false;
  }
  try {
    // Pass the promise straight into ClipboardItem: Safari requires the
    // clipboard write to stay within the user-gesture call stack.
    const item = new ClipboardItem({
      "image/png": fetch(url).then((r) => r.blob()),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}

/** Trigger a browser download of `url` named `filename`. */
export function downloadFile(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Last path segment of a host path, for toast text / download names. */
export function captureBasename(path: string): string {
  return path.split("/").pop() ?? path;
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
bun run typecheck
git add packages/serve-sim/src/client/utils/captures.ts
git commit -m "feat: ✨ client capture API wrapper + clipboard/download helpers"
```

---

### Task 7: toolbar UI — screenshot button + record toggle + toasts

**Files:**
- Create: `packages/serve-sim/src/client/components/record-toolbar-button.tsx`
- Modify: `packages/serve-sim/src/client/hooks/use-upload-toasts.ts`
- Modify: `packages/serve-sim/src/client/client.tsx`

- [ ] **Step 1: Generalize the toast hook for capture notifications**

In `use-upload-toasts.ts`, widen `kind` and let an explicit `message` win in success state. Replace the type with:

```typescript
export type UploadToast = {
  id: string;
  name: string;
  kind: DropKind | "capture";
  status: "uploading" | "success" | "error";
  progress: number | null;
  message?: string;
};
```

and change `add` to accept the widened kind:

```typescript
  const add = useCallback((name: string, kind: DropKind | "capture"): string => {
```

In `client.tsx`'s toast rendering (~line 868-876), make `message` take priority so capture toasts can say "Copied to clipboard …":

```tsx
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {isUploading && transferring &&
                      `Uploading ${t.name}… ${pct}%`}
                    {isUploading && !transferring &&
                      (t.message ?? (t.kind === "ipa" ? `Installing ${t.name}…` : `Adding ${t.name}…`))}
                    {t.status === "success" &&
                      (t.message ?? (t.kind === "ipa" ? `Installed ${t.name}` : `Added ${t.name} to Photos`))}
                    {isError && `${t.name}: ${t.message ?? "Upload failed"}`}
                  </span>
```

- [ ] **Step 2: Create the record toggle button**

```tsx
// packages/serve-sim/src/client/components/record-toolbar-button.tsx
import { useEffect, useState } from "react";
import { SimulatorToolbar } from "serve-sim-client/simulator";
import {
  captureBasename,
  downloadFile,
  recordingStatus,
  startRecording,
  stopRecording,
} from "../utils/captures";

type RecordingInfo = { path: string; startedAt: number };

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const RecordIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </svg>
);

const StopIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </svg>
);

export function RecordToolbarButton({
  udid,
  onResult,
}: {
  udid: string | null;
  onResult: (ok: boolean, message: string) => void;
}) {
  const [recording, setRecording] = useState<RecordingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Re-render every second while recording so the elapsed label ticks.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // Sync with a recording started before this page load (or from the CLI).
  useEffect(() => {
    if (!udid) return;
    let cancelled = false;
    recordingStatus(udid).then((s) => {
      if (cancelled) return;
      setRecording(s.recording && s.path && s.startedAt ? { path: s.path, startedAt: s.startedAt } : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [udid]);

  const handleClick = async () => {
    if (!udid || busy) return;
    setBusy(true);
    try {
      if (recording) {
        const r = await stopRecording(udid);
        setRecording(null);
        if (r.ok && r.path && r.url) {
          downloadFile(r.url, captureBasename(r.path));
          onResult(true, `Saved recording to ${r.path}`);
        } else {
          onResult(false, r.error ?? "Failed to stop recording");
        }
      } else {
        const r = await startRecording(udid);
        if (r.ok && r.path && r.startedAt) {
          setRecording({ path: r.path, startedAt: r.startedAt });
        } else {
          onResult(false, r.error ?? "Failed to start recording");
        }
      }
    } catch (err) {
      onResult(false, err instanceof Error ? err.message : "Recording request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SimulatorToolbar.Button
      aria-label={recording ? "Stop recording" : "Start recording"}
      title={recording ? `Recording ${formatElapsed(now - recording.startedAt)} — click to stop` : "Record screen"}
      aria-pressed={!!recording}
      onClick={() => void handleClick()}
      style={recording ? { color: "#f87171" } : undefined}
    >
      {recording ? StopIcon : RecordIcon}
    </SimulatorToolbar.Button>
  );
}
```

(If `SimulatorToolbar.Button` doesn't forward `style`, check `ToolbarButton` in `packages/serve-sim-client/src/simulator/SimulatorToolbar.tsx` — it extends `ButtonHTMLAttributes`, so `style` passes through; merge with any internal style if needed.)

- [ ] **Step 3: Add both buttons to the toolbar in client.tsx**

Imports:

```typescript
import { RecordToolbarButton } from "./components/record-toolbar-button";
import { captureBasename, copyImageToClipboard, downloadFile, takeScreenshot } from "./utils/captures";
```

Inside `App()`, next to the other handlers (after `onStreamButton`, ~line 433):

```typescript
  const notifyCapture = useCallback((ok: boolean, message: string) => {
    const id = uploads.add("capture", "capture");
    uploads.update(id, { status: ok ? "success" : "error", message });
  }, [uploads]);

  const handleScreenshot = useCallback(async () => {
    try {
      const r = await takeScreenshot(config.device);
      if (!r.ok || !r.path || !r.url) {
        notifyCapture(false, r.error ?? "Screenshot failed");
        return;
      }
      const copied = await copyImageToClipboard(r.url);
      if (!copied) downloadFile(r.url, captureBasename(r.path));
      notifyCapture(true, copied
        ? `Copied to clipboard (saved to ${r.path})`
        : `Saved to ${r.path}`);
    } catch (err) {
      notifyCapture(false, err instanceof Error ? err.message : "Screenshot failed");
    }
  }, [config.device, notifyCapture]);
```

Note: `uploads` is declared at ~line 639, *after* this spot — declare `notifyCapture`/`handleScreenshot` after the `const uploads = useUploadToasts();` line instead so the reference exists.

In the toolbar JSX (~line 744-763), add between `AxToolbarButton` and `RotateButton`:

```tsx
            <SimulatorToolbar.Button
              aria-label="Screenshot"
              title="Screenshot (copies to clipboard)"
              onClick={() => void handleScreenshot()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </SimulatorToolbar.Button>
            <RecordToolbarButton udid={config.device} onResult={notifyCapture} />
```

- [ ] **Step 4: Build the client bundle and typecheck**

Run: `bun run packages/serve-sim/build.ts`
Expected: build completes; `dist/serve-sim.js` regenerated.
Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/serve-sim/src/client/components/record-toolbar-button.tsx \
        packages/serve-sim/src/client/hooks/use-upload-toasts.ts \
        packages/serve-sim/src/client/client.tsx
git commit -m "feat: ✨ screenshot + record buttons in preview toolbar"
```

---

### Task 8: E2E verification

**Files:** none (verification only) — follows the CLAUDE.md e2e flow.

- [ ] **Step 1: Rebuild and start the server against a booted simulator**

```bash
bun run packages/serve-sim/build.ts
xcrun simctl list devices booted   # boot one via Simulator.app / simctl boot if empty
node packages/serve-sim/dist/serve-sim.js --port 3399 &
```

- [ ] **Step 2: CLI screenshot e2e**

```bash
node packages/serve-sim/dist/serve-sim.js screenshot
```
Expected: prints a path under `./serve-sim-captures/`; `file <path>` reports PNG image data with the device's pixel dimensions.

- [ ] **Step 3: CLI record e2e**

```bash
node packages/serve-sim/dist/serve-sim.js record start
node packages/serve-sim/dist/serve-sim.js tap 0.5 0.5
sleep 3
node packages/serve-sim/dist/serve-sim.js record status   # → {"recording":true,...}
node packages/serve-sim/dist/serve-sim.js record stop
```
Expected: `stop` prints an MP4 path; `file <path>` reports ISO Media MP4; size > 0; plays in QuickTime.

- [ ] **Step 4: Endpoint e2e (same flow the browser uses)**

```bash
curl -s -X POST localhost:3399/api/screenshot -H 'Content-Type: application/json' -d '{}' | jq .
curl -s -o /tmp/cap.png "localhost:3399$(curl -s -X POST localhost:3399/api/screenshot -H 'Content-Type: application/json' -d '{}' | jq -r .url)" && file /tmp/cap.png
```
Expected: `{ok:true, path, url}`; downloaded file is a valid PNG.

- [ ] **Step 5: WebUI e2e with agent-browser**

```bash
agent-browser open http://localhost:3399
agent-browser snapshot          # find the Screenshot / Record buttons by aria-label
agent-browser click "[aria-label=Screenshot]"
agent-browser screenshot /tmp/ui-after-shot.png   # toast visible
agent-browser click "[aria-label='Start recording']"
sleep 3
agent-browser click "[aria-label='Stop recording']"
```
Expected: screenshot click shows a "Copied to clipboard (saved to …)" or "Saved to …" toast; record toggle turns red while recording; stop produces a download and a "Saved recording to …" toast. Cross-check `ls serve-sim-captures/`.

- [ ] **Step 6: Cross-surface check (CLI stops a WebUI recording)**

Start recording from the web UI, then:
```bash
node packages/serve-sim/dist/serve-sim.js record stop
```
Expected: prints the MP4 path; the web UI button resets on next page load (status sync).

---

### Task 9: docs + cleanup

**Files:**
- Modify: `CLAUDE.md` (repo root — add the new CLI verbs to the e2e section)
- Delete: `docs/superpowers/` (user request: remove design docs once done)

- [ ] **Step 1: Add the new commands to CLAUDE.md's CLI list**

In the "E2E testing via the serve-sim CLI" bullet list, after the `serve-sim camera …` line, add:

```markdown
- `serve-sim screenshot [-o path] [-d udid]` — save a PNG of the simulator
  screen (default: `./serve-sim-captures/`); prints the saved path.
- `serve-sim record start|stop|status [-d udid]` — record the screen to MP4;
  `stop` prints the saved path. Works for recordings started from the web UI too.
```

- [ ] **Step 2: Delete the superpowers design docs (per user request)**

```bash
git rm -r docs/superpowers
```

- [ ] **Step 3: Final full test run + commit**

```bash
cd packages/serve-sim && bun test && cd ../..
bun run typecheck && bun run lint
git add CLAUDE.md
git commit -m "docs: 📝 document screenshot/record CLI; drop design docs"
```
