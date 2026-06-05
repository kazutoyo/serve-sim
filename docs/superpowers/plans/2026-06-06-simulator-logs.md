# Simulator Log Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose iOS Simulator logs to agents via a `serve-sim logs` CLI subcommand and to humans via a Logs panel in the web UI, defaulting to the foreground app's process logs.

**Architecture:** On-demand `simctl` invocations — `log show --last` for snapshots, `log stream` for live tail — with a process predicate built from the foreground app (or `--app <bundleId>`). Pure helpers live in `src/logs.ts` (importable by the browser bundle); node-only exec wrappers live in `src/logs-exec.ts`; the CLI and the middleware SSE endpoint both build on them.

**Tech Stack:** TypeScript, Bun (`bun:test`), commander, React 19 (web UI), `xcrun simctl spawn <udid> log show|stream --style ndjson`.

**Spec:** `docs/superpowers/specs/2026-06-06-simulator-logs-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/serve-sim/src/logs.ts` | Create | Pure helpers: types, simctl argv builders, predicate builder, NDJSON parser, formatter. **No node imports** — the client bundle imports `parseLogLine` from here. |
| `packages/serve-sim/src/logs-exec.ts` | Create | Node-only wrappers: `listInstalledApps`, `resolveAppProcess`, `fetchForegroundApp`. |
| `packages/serve-sim/src/__tests__/logs.test.ts` | Create | Unit tests for everything in `logs.ts`. |
| `packages/serve-sim/src/__tests__/logs.e2e.test.ts` | Create | CLI e2e against a booted simulator (skips when none). |
| `packages/serve-sim/src/index.ts` | Modify | `logs` subcommand (commander registration ~line 1988, implementation near `tap`/`gesture` ~line 860). |
| `packages/serve-sim/src/middleware.ts` | Modify | Extend `GET {base}/logs` (lines 1247–1292) with `scope`/`level` query params. |
| `packages/serve-sim/src/client/components/logs-panel.tsx` | Create | LogsPanel component (SSE subscribe, buffer, filters, auto-scroll). |
| `packages/serve-sim/src/client/utils/panel-widths.ts` | Modify | Add `LOGS_PANEL_WIDTH`. |
| `packages/serve-sim/src/client/client.tsx` | Modify | Toolbar button + panel wiring (rail at ~line 896, panels at ~line 953, shift calc at ~line 680). |
| `skills/serve-sim/SKILL.md`, `skills/serve-sim/references/endpoints.md` | Modify | Document the new command and query params. |

Conventions to follow (verified in the codebase):

- Tests use `bun:test` (`import { describe, expect, test } from "bun:test"`), live in `src/__tests__/`, kebab-case filenames.
- e2e tests skip when no booted sim / no built CLI — copy the `describeIfSim` pattern from `src/__tests__/permissions.e2e.test.ts`.
- CLI commands print a clear error + `process.exit(1)` on bad input (see `tap` at `src/index.ts:897`).
- Run checks with: `bun test packages/serve-sim/src/__tests__/logs.test.ts`, `bun run typecheck`, `bun run lint` (repo root).

Known simctl facts (verified on this machine):

- `log show` has **no `--level`** — info/debug visibility uses `--info` / `--debug` flags. `log stream` uses `--level <default|info|debug>`.
- NDJSON entry fields: `eventMessage`, `messageType` (`"Default" | "Info" | "Debug" | "Error" | "Fault"`), `processImagePath`, `senderImagePath`, `subsystem`, `category`, `processID`, `timestamp` (`"2026-06-06 07:47:07.934213+0900"`).
- `xcrun simctl listapps <udid>` prints an OpenStep plist; pipe through `plutil -convert json -o - -- -` to get JSON keyed by bundle id with `CFBundleExecutable`.
- The Swift helper's `GET http://127.0.0.1:<port>/foreground` returns `{bundleId, pid}` (HTTPServer.swift:158).

---

### Task 1: Pure helpers — predicate, argv builders (`src/logs.ts`)

**Files:**
- Create: `packages/serve-sim/src/__tests__/logs.test.ts`
- Create: `packages/serve-sim/src/logs.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/serve-sim/src/__tests__/logs.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  buildLogShowArgs,
  buildLogStreamArgs,
  buildProcessPredicate,
  isValidLastDuration,
} from "../logs";

describe("buildProcessPredicate", () => {
  test("wraps the process name in an equality predicate", () => {
    expect(buildProcessPredicate("TNStudio")).toBe('process == "TNStudio"');
  });

  test("escapes double quotes so a hostile name cannot break out", () => {
    expect(buildProcessPredicate('Evil" OR process != "')).toBe(
      'process == "Evil\\" OR process != \\""',
    );
  });

  test("escapes backslashes before quotes", () => {
    expect(buildProcessPredicate('a\\"b')).toBe('process == "a\\\\\\"b"');
  });
});

describe("isValidLastDuration", () => {
  test.each(["30s", "1m", "2h", "1d", "90"])("accepts %s", (v) => {
    expect(isValidLastDuration(v)).toBe(true);
  });

  test.each(["", "1w", "m", "1.5m", "30 s", "-1m", "1m; rm -rf /"])(
    "rejects %s",
    (v) => {
      expect(isValidLastDuration(v)).toBe(false);
    },
  );
});

describe("buildLogShowArgs", () => {
  test("builds a snapshot argv with --last", () => {
    expect(buildLogShowArgs({ udid: "UDID-1", last: "1m" })).toEqual([
      "simctl", "spawn", "UDID-1", "log", "show",
      "--style", "ndjson", "--last", "1m",
    ]);
  });

  test("level info adds --info; debug adds --info --debug (log show has no --level)", () => {
    expect(buildLogShowArgs({ udid: "U", last: "30s", level: "info" })).toContain("--info");
    const debug = buildLogShowArgs({ udid: "U", last: "30s", level: "debug" });
    expect(debug).toContain("--info");
    expect(debug).toContain("--debug");
    expect(debug).not.toContain("--level");
  });

  test("appends the predicate when given", () => {
    const args = buildLogShowArgs({ udid: "U", last: "1m", predicate: 'process == "App"' });
    expect(args.slice(-2)).toEqual(["--predicate", 'process == "App"']);
  });
});

describe("buildLogStreamArgs", () => {
  test("builds a stream argv with --level (default: info)", () => {
    expect(buildLogStreamArgs({ udid: "UDID-1" })).toEqual([
      "simctl", "spawn", "UDID-1", "log", "stream",
      "--style", "ndjson", "--level", "info",
    ]);
  });

  test("passes level and predicate through", () => {
    const args = buildLogStreamArgs({ udid: "U", level: "debug", predicate: 'process == "App"' });
    expect(args).toContain("debug");
    expect(args.slice(-2)).toEqual(["--predicate", 'process == "App"']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/serve-sim/src/__tests__/logs.test.ts`
Expected: FAIL — `Cannot find module '../logs'`

- [ ] **Step 3: Write the minimal implementation**

Create `packages/serve-sim/src/logs.ts` (pure — **no node imports**, the client bundle imports from this file):

```typescript
/**
 * Pure helpers for simulator log access, shared by the CLI (`serve-sim logs`),
 * the middleware SSE endpoint, and the web UI's Logs panel. Keep this file
 * free of node imports — it is bundled into the browser client.
 */

export type LogLevel = "default" | "info" | "debug";

export const LOG_LEVELS: readonly LogLevel[] = ["default", "info", "debug"];

/**
 * `log(1)` predicate matching a single process by executable name, with
 * quotes/backslashes escaped so an app name can't inject predicate syntax.
 */
export function buildProcessPredicate(processName: string): string {
  const escaped = processName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `process == "${escaped}"`;
}

/** `log show --last` accepts `<n>[s|m|h|d]` (bare numbers mean seconds). */
export function isValidLastDuration(value: string): boolean {
  return /^\d+[smhd]?$/.test(value);
}

/**
 * argv (for `xcrun`) of a snapshot read from the OS log archive.
 * `log show` has no `--level`; info/debug visibility is flag-based.
 */
export function buildLogShowArgs(opts: {
  udid: string;
  last: string;
  level?: LogLevel;
  predicate?: string;
}): string[] {
  const args = [
    "simctl", "spawn", opts.udid, "log", "show",
    "--style", "ndjson", "--last", opts.last,
  ];
  if (opts.level === "info" || opts.level === "debug") args.push("--info");
  if (opts.level === "debug") args.push("--debug");
  if (opts.predicate) args.push("--predicate", opts.predicate);
  return args;
}

/** argv (for `xcrun`) of a live `log stream` tail. */
export function buildLogStreamArgs(opts: {
  udid: string;
  level?: LogLevel;
  predicate?: string;
}): string[] {
  const args = [
    "simctl", "spawn", opts.udid, "log", "stream",
    "--style", "ndjson", "--level", opts.level ?? "info",
  ];
  if (opts.predicate) args.push("--predicate", opts.predicate);
  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/serve-sim/src/__tests__/logs.test.ts`
Expected: PASS (all describe blocks)

- [ ] **Step 5: Commit**

```bash
git add packages/serve-sim/src/logs.ts packages/serve-sim/src/__tests__/logs.test.ts
git commit -m "feat: ✨ シミュレーターログ用のsimctl引数ビルダーとpredicate生成を追加"
```

---

### Task 2: Pure helpers — NDJSON parse, format, bundle lookup (`src/logs.ts`)

**Files:**
- Modify: `packages/serve-sim/src/__tests__/logs.test.ts`
- Modify: `packages/serve-sim/src/logs.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/serve-sim/src/__tests__/logs.test.ts` (extend the import from `../logs` with `parseLogLine`, `formatLogEntry`, `findExecutableForBundle`, and `type LogEntry`):

```typescript
// Real `log show --style ndjson` entry, trimmed to the fields we read.
const SAMPLE_LINE = JSON.stringify({
  timezoneName: "",
  messageType: "Default",
  eventType: "logEvent",
  subsystem: "com.apple.coreaudio",
  category: "sss",
  processImagePath: "/Volumes/iOS 26.4.simruntime/RuntimeRoot/usr/libexec/systemsoundserver-simd",
  senderImagePath: "/Volumes/iOS 26.4.simruntime/RuntimeRoot/usr/libexec/systemsoundserver-simd",
  timestamp: "2026-06-06 07:47:07.934213+0900",
  eventMessage: "Data was marked NON-purgeable for actionID: 4097",
  processID: 39653,
});

describe("parseLogLine", () => {
  test("parses a real simctl NDJSON entry", () => {
    expect(parseLogLine(SAMPLE_LINE)).toEqual({
      timestamp: "2026-06-06 07:47:07.934213+0900",
      level: "Default",
      process: "systemsoundserver-simd",
      pid: 39653,
      subsystem: "com.apple.coreaudio",
      category: "sss",
      message: "Data was marked NON-purgeable for actionID: 4097",
    });
  });

  test.each([
    "",
    "Filtering the log data using ...",   // log show header noise
    "{ not json",
    JSON.stringify({ messageType: "Default" }), // no eventMessage
  ])("returns null for garbage line %#", (line) => {
    expect(parseLogLine(line)).toBeNull();
  });

  test("falls back to senderImagePath when processImagePath is missing", () => {
    const entry = parseLogLine(JSON.stringify({
      eventMessage: "hi",
      senderImagePath: "/usr/lib/libfoo.dylib",
      timestamp: "2026-06-06 07:47:07.934213+0900",
    }));
    expect(entry?.process).toBe("libfoo.dylib");
    expect(entry?.level).toBe("Default");
    expect(entry?.pid).toBe(0);
  });
});

describe("formatLogEntry", () => {
  const entry: LogEntry = {
    timestamp: "2026-06-06 07:47:07.934213+0900",
    level: "Error",
    process: "TNStudio",
    pid: 1,
    subsystem: "",
    category: "",
    message: "boom",
  };

  test("renders time, level, process and message", () => {
    expect(formatLogEntry(entry)).toBe("07:47:07.934 ERROR   TNStudio: boom");
  });

  test("survives an empty timestamp", () => {
    expect(formatLogEntry({ ...entry, timestamp: "" })).toBe(
      "--:--:--.--- ERROR   TNStudio: boom",
    );
  });
});

describe("findExecutableForBundle", () => {
  const apps = {
    "com.example.app": { CFBundleExecutable: "ExampleApp" },
    "com.example.empty": {},
  };

  test("returns the executable name for an installed bundle", () => {
    expect(findExecutableForBundle(apps, "com.example.app")).toBe("ExampleApp");
  });

  test("returns null for unknown bundle or missing executable", () => {
    expect(findExecutableForBundle(apps, "com.example.empty")).toBeNull();
    expect(findExecutableForBundle(apps, "com.nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/serve-sim/src/__tests__/logs.test.ts`
Expected: FAIL — `parseLogLine` etc. are not exported

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/serve-sim/src/logs.ts`:

```typescript
export interface LogEntry {
  /** As emitted by simctl, e.g. "2026-06-06 07:47:07.934213+0900". */
  timestamp: string;
  /** "Default" | "Info" | "Debug" | "Error" | "Fault". */
  level: string;
  /** Executable name, e.g. "TNStudio". */
  process: string;
  pid: number;
  subsystem: string;
  category: string;
  message: string;
}

/**
 * One NDJSON line → LogEntry. Tolerant of the non-JSON noise simctl mixes in
 * ("Filtering the log data..." headers, truncated lines): returns null and
 * the caller skips the line.
 */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = typeof raw.eventMessage === "string" ? raw.eventMessage : "";
  if (!message) return null;
  const imagePath =
    (typeof raw.processImagePath === "string" && raw.processImagePath) ||
    (typeof raw.senderImagePath === "string" && raw.senderImagePath) ||
    "";
  return {
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
    level:
      typeof raw.messageType === "string" && raw.messageType !== ""
        ? raw.messageType
        : "Default",
    process: imagePath.split("/").pop() ?? "",
    pid: typeof raw.processID === "number" ? raw.processID : 0,
    subsystem: typeof raw.subsystem === "string" ? raw.subsystem : "",
    category: typeof raw.category === "string" ? raw.category : "",
    message,
  };
}

/** "HH:MM:SS.mmm LEVEL process: message" — one line per entry. */
export function formatLogEntry(entry: LogEntry): string {
  // timestamp is "YYYY-MM-DD HH:MM:SS.ffffff+ZZZZ"; slice avoids TZ parsing.
  const time = entry.timestamp.slice(11, 23) || "--:--:--.---";
  const level = entry.level.toUpperCase().padEnd(7);
  return `${time} ${level} ${entry.process}: ${entry.message}`;
}

/** Minimal shape of one `simctl listapps` entry (after plutil → JSON). */
export type ListedApp = { CFBundleExecutable?: string };

/** Predicates match process names, not bundle ids — map via listapps output. */
export function findExecutableForBundle(
  apps: Record<string, ListedApp>,
  bundleId: string,
): string | null {
  const exe = apps[bundleId]?.CFBundleExecutable;
  return typeof exe === "string" && exe.length > 0 ? exe : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/serve-sim/src/__tests__/logs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/serve-sim/src/logs.ts packages/serve-sim/src/__tests__/logs.test.ts
git commit -m "feat: ✨ ログNDJSONパーサー・整形・bundle実行ファイル解決を追加"
```

---

### Task 3: Node-only exec wrappers (`src/logs-exec.ts`)

**Files:**
- Create: `packages/serve-sim/src/logs-exec.ts`

These are thin wrappers around `execFileSync`/`fetch`; their logic-bearing parts (`findExecutableForBundle`, argv builders) are already unit-tested in Tasks 1–2, and the wrappers themselves are exercised by the e2e test in Task 7. No new unit test.

- [ ] **Step 1: Write the implementation**

Create `packages/serve-sim/src/logs-exec.ts`:

```typescript
import { execFileSync } from "child_process";
import { findExecutableForBundle, type ListedApp } from "./logs";

/**
 * Installed apps on a device, keyed by bundle id. `simctl listapps` prints an
 * OpenStep plist; plutil converts it to JSON (it reads OpenStep, writes JSON).
 */
export function listInstalledApps(udid: string): Record<string, ListedApp> {
  const plist = execFileSync("xcrun", ["simctl", "listapps", udid], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const json = execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input: plist,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(json) as Record<string, ListedApp>;
}

/** Executable name for a bundle id, or null when not installed / lookup fails. */
export function resolveAppProcess(udid: string, bundleId: string): string | null {
  try {
    return findExecutableForBundle(listInstalledApps(udid), bundleId);
  } catch {
    return null;
  }
}

/**
 * Frontmost app via the running Swift helper's `/foreground` probe.
 * Null when the helper is unreachable or reports no foreground app.
 */
export async function fetchForegroundApp(
  port: number,
): Promise<{ bundleId: string; pid: number } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/foreground`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { bundleId?: string; pid?: number };
    if (typeof data.bundleId !== "string" || data.bundleId === "") return null;
    return { bundleId: data.bundleId, pid: typeof data.pid === "number" ? data.pid : 0 };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify it compiles and existing tests still pass**

Run: `bun run typecheck && bun test packages/serve-sim/src/__tests__/logs.test.ts`
Expected: typecheck clean, tests PASS

- [ ] **Step 3: Smoke-test against the booted simulator (manual, if one is booted)**

Run: `cd packages/serve-sim && bun -e 'import { listInstalledApps } from "./src/logs-exec.ts"; const udid = process.argv[1]; console.log(Object.keys(listInstalledApps(udid)).length, "apps");' "$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(dev["udid"] for r in d["devices"].values() for dev in r if dev["state"]=="Booted"))')"`
Expected: prints an app count > 0. (Skip this step if no simulator is booted.)

- [ ] **Step 4: Commit**

```bash
git add packages/serve-sim/src/logs-exec.ts
git commit -m "feat: ✨ listapps/foreground解決のnode専用ラッパーを追加"
```

---

### Task 4: CLI subcommand `serve-sim logs`

**Files:**
- Modify: `packages/serve-sim/src/index.ts`

- [ ] **Step 1: Add the implementation function**

In `packages/serve-sim/src/index.ts`, add imports at the top (near the existing `./permissions` import):

```typescript
import {
  buildLogShowArgs,
  buildLogStreamArgs,
  buildProcessPredicate,
  formatLogEntry,
  isValidLastDuration,
  parseLogLine,
  LOG_LEVELS,
  type LogLevel,
} from "./logs";
import { fetchForegroundApp, resolveAppProcess } from "./logs-exec";
```

Add the command function after `memoryWarning` (i.e. before the `camera` section). Note it does NOT require a running serve-sim server — only the default foreground-app resolution does:

```typescript
async function logsCommand(opts: {
  device?: string;
  last?: string;
  follow?: boolean;
  app?: string;
  system?: boolean;
  level?: string;
  json?: boolean;
}) {
  if (opts.last && opts.follow) {
    console.error("--last and --follow are mutually exclusive.");
    process.exit(1);
  }
  if (opts.app && opts.system) {
    console.error("--app and --system are mutually exclusive.");
    process.exit(1);
  }
  const level = (opts.level ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(level)) {
    console.error(`Invalid --level: ${opts.level}. Use default | info | debug.`);
    process.exit(1);
  }
  const last = opts.last ?? "1m";
  if (!isValidLastDuration(last)) {
    console.error(`Invalid --last duration: ${last}. Use e.g. 30s, 2m, 1h.`);
    process.exit(1);
  }

  // Resolve the target device. Unlike tap/gesture this doesn't need a running
  // server — simctl reads the OS log archive directly.
  const udid = opts.device
    ? resolveDevice(opts.device)
    : readState()?.device ?? findBootedDevice();
  if (!udid) {
    console.error("No booted simulator found.");
    process.exit(1);
  }

  // Scope: default = foreground app (needs the running helper); --app skips
  // the helper; --system skips filtering entirely.
  let predicate: string | undefined;
  if (!opts.system) {
    let bundleId = opts.app ?? null;
    if (!bundleId) {
      const state = readState(opts.device ? udid : undefined);
      const fg = state ? await fetchForegroundApp(state.port) : null;
      if (!fg) {
        console.error("Could not determine the foreground app (is `serve-sim` running?).");
        console.error("Pass --app <bundleId> for a specific app, or --system for everything.");
        process.exit(1);
      }
      bundleId = fg.bundleId;
    }
    const processName = resolveAppProcess(udid, bundleId);
    if (!processName) {
      console.error(`App not installed on device ${udid}: ${bundleId}`);
      process.exit(1);
    }
    predicate = buildProcessPredicate(processName);
  }

  const args = opts.follow
    ? buildLogStreamArgs({ udid, level, predicate })
    : buildLogShowArgs({ udid, last, level, predicate });
  const child = nodeSpawn("xcrun", args, { stdio: ["ignore", "pipe", "inherit"] });

  let buf = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (opts.json) {
        if (line.trim().startsWith("{")) console.log(line);
        continue;
      }
      const entry = parseLogLine(line);
      if (entry) console.log(formatLogEntry(entry));
    }
  });
  child.on("error", (err) => {
    console.error("Failed to run simctl:", err.message);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 0));
}
```

- [ ] **Step 2: Register the command**

In the commander section (after the `memory-warning` registration, `src/index.ts:1978-1982`):

```typescript
program
  .command("logs")
  .description("Show simulator logs (default: last 1m of the foreground app)")
  .option(...deviceOpt)
  .option("--last <duration>", "Snapshot window, e.g. 30s, 2m (snapshot mode default: 1m)")
  .option("-f, --follow", "Stream logs live (mutually exclusive with --last)")
  .option("--app <bundleId>", "Only logs from this app's process")
  .option("--system", "Full system log (no process filter)")
  .option("--level <level>", "default | info | debug", "info")
  .option("--json", "Raw NDJSON output instead of formatted text")
  .action((opts) => logsCommand(opts));
```

Note: `deviceOpt` is declared at `src/index.ts:1922`, *after* some command registrations but before `gesture` uses it — place `logs` next to the other registrations that already reference it (after `memory-warning`).

- [ ] **Step 3: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean

- [ ] **Step 4: Manual smoke test (booted simulator)**

Run: `cd packages/serve-sim && bun src/index.ts logs --system --last 10s | head -5`
Expected: ~5 formatted lines like `07:47:07.934 DEFAULT systemsoundserver-simd: ...`

Run: `cd packages/serve-sim && bun src/index.ts logs --system --last 10s --json | head -2`
Expected: raw NDJSON lines

Run: `cd packages/serve-sim && bun src/index.ts logs --last 1m --follow`
Expected: error `--last and --follow are mutually exclusive.`, exit code 1

- [ ] **Step 5: Commit**

```bash
git add packages/serve-sim/src/index.ts
git commit -m "feat: ✨ serve-sim logsサブコマンドを追加(スナップショット/follow/アプリ絞り込み)"
```

---

### Task 5: Middleware — `scope`/`level` query params on `GET {base}/logs`

**Files:**
- Modify: `packages/serve-sim/src/middleware.ts:1247-1292`

- [ ] **Step 1: Rewrite the `/logs` handler**

In `packages/serve-sim/src/middleware.ts`, add imports at the top (near the other `./`-relative imports):

```typescript
import { buildLogStreamArgs, buildProcessPredicate, type LogLevel } from "./logs";
import { fetchForegroundApp, resolveAppProcess } from "./logs-exec";
```

Replace the body of the `if (url === base + "/logs") { ... }` block (lines 1247–1292). The SSE headers, state lookup, line pump, and cleanup stay as they are — the diff is (a) parsing `scope`/`level` from the query, (b) resolving the predicate before spawning, (c) the `event: error` fallback, and (d) spawning asynchronously while keeping `req.on("close")` effective:

```typescript
    // SSE: simctl log stream.
    //   ?scope=app    — filter to the foreground app (resolved at connect time)
    //   ?scope=system — unfiltered (default; matches pre-scope behavior)
    //   ?level=...    — default | info | debug (default: info)
    if (url === base + "/logs") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const udid = state.device;
      const params = qIndex === -1
        ? new URLSearchParams()
        : new URLSearchParams(rawUrl.slice(qIndex + 1));
      const scope = params.get("scope") === "app" ? "app" : "system";
      const levelParam = params.get("level");
      const level: LogLevel =
        levelParam === "debug" || levelParam === "default" ? levelParam : "info";

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      // The predicate lookup awaits the helper's /foreground probe, so the
      // child is spawned async; keep it visible to the close handler below.
      let child: ChildProcess | null = null;
      let closed = false;

      (async () => {
        let predicate: string | undefined;
        if (scope === "app") {
          const fg = await fetchForegroundApp(state.port);
          const processName = fg ? resolveAppProcess(udid, fg.bundleId) : null;
          if (processName) {
            predicate = buildProcessPredicate(processName);
          } else {
            // Scope-resolution failure: report it but keep the connection
            // open on the unfiltered stream (spec: graceful fallback).
            res.write(`event: error\ndata: ${JSON.stringify({
              message: "Could not resolve the foreground app; streaming the system log",
            })}\n\n`);
          }
        }
        if (closed) return;

        child = spawn("xcrun", buildLogStreamArgs({ udid, level, predicate }), {
          stdio: ["ignore", "pipe", "ignore"],
        });

        let buf = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) res.write("data: " + line + "\n\n");
          }
          // Drop a runaway partial line so a malformed/never-terminated
          // log entry can't grow `buf` without bound.
          if (buf.length > SSE_LINE_BUFFER_LIMIT) buf = "";
        });

        child.on("error", () => {
          // Spawn failure: emit the error and close (spec: distinct from
          // scope-resolution fallback above).
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ message: "Failed to spawn simctl log stream" })}\n\n`);
          } catch {}
          try { res.end(); } catch {}
        });
        child.on("close", () => res.end());
      })();

      req.on("close", () => {
        closed = true;
        child?.stdout?.destroy();
        child?.kill();
      });
      return;
    }
```

- [ ] **Step 2: Typecheck, lint, and run the middleware test suite**

Run: `bun run typecheck && bun run lint && bun test packages/serve-sim/src/__tests__ --timeout 60000`
Expected: clean, all tests pass (no existing test asserts on `/logs` internals; `middleware-selection.test.ts` covers the unchanged state-selection helpers)

- [ ] **Step 3: Manual smoke test (booted sim + running server)**

```bash
cd packages/serve-sim && bun run build.ts && node dist/serve-sim.js --detach --port 3399
curl -sN "http://localhost:3399/.sim/logs?scope=system" | head -5
curl -sN "http://localhost:3399/.sim/logs?scope=app" | head -5
```
Expected: `data: {...}` SSE lines; with `scope=app` either only foreground-app entries, or an `event: error` line followed by the system stream.

- [ ] **Step 4: Commit**

```bash
git add packages/serve-sim/src/middleware.ts
git commit -m "feat: ✨ /logsエンドポイントにscope/levelクエリパラメータを追加"
```

---

### Task 6: Web UI — LogsPanel component + wiring

**Files:**
- Create: `packages/serve-sim/src/client/components/logs-panel.tsx`
- Modify: `packages/serve-sim/src/client/utils/panel-widths.ts`
- Modify: `packages/serve-sim/src/client/client.tsx`

- [ ] **Step 1: Add the width constant**

In `packages/serve-sim/src/client/utils/panel-widths.ts` append:

```typescript
export const LOGS_PANEL_WIDTH = 560;
```

- [ ] **Step 2: Create the LogsPanel component**

Create `packages/serve-sim/src/client/components/logs-panel.tsx`. Notes:
- SSE subscription is an external-system sync → `useEffect` is correct here.
- Entries are batched through a ref + 250ms flush so a chatty system stream doesn't re-render per event.
- Reconnect is driven by the effect deps: scope toggle and foreground-app change (`currentAppKey`) re-run the effect (spec: client reconnects, server does not re-predicate).
- Level colors follow the console palette already used in `client.tsx` (`#ff5555` error, `#6272a4` debug); no low-opacity icons.

```tsx
import { useEffect, useRef, useState } from "react";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { formatLogEntry, parseLogLine, type LogEntry } from "../../logs";

const MAX_ENTRIES = 2000;
const FLUSH_INTERVAL_MS = 250;

function levelColor(level: string): string {
  switch (level.toLowerCase()) {
    case "error":
    case "fault":
      return "#ff5555";
    case "debug":
      return "#6272a4";
    default:
      return "rgba(255,255,255,0.85)";
  }
}

export function LogsPanel({
  open,
  onClose,
  logsEndpoint,
  currentAppKey,
  width,
}: {
  open: boolean;
  onClose: () => void;
  /** `{base}/logs?device=...` from the preview config. */
  logsEndpoint: string;
  /** Foreground bundle id; a change re-subscribes so scope=app re-resolves. */
  currentAppKey: string | null;
  width: number;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [scope, setScope] = useState<"app" | "system">("app");
  const [levelFilter, setLevelFilter] = useState<"all" | "error">("all");
  const [textFilter, setTextFilter] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<LogEntry[]>([]);

  // Subscribe to the SSE stream while the panel is open. Scope toggles and
  // foreground-app changes re-run this effect → fresh connection with the
  // newly-resolved predicate (the server resolves scope at connect time).
  useEffect(() => {
    if (!open) return;
    setStreamError(null);
    const sep = logsEndpoint.includes("?") ? "&" : "?";
    const es = new EventSource(`${logsEndpoint}${sep}scope=${scope}`);
    es.onmessage = (event) => {
      const entry = parseLogLine(event.data);
      if (entry) pendingRef.current.push(entry);
    };
    es.addEventListener("error", (event) => {
      // Server-sent `event: error` carries a message; transport errors don't.
      const data = (event as MessageEvent).data as string | undefined;
      if (data) {
        try { setStreamError((JSON.parse(data) as { message?: string }).message ?? "Log stream error"); } catch {}
      }
    });
    const timer = setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
      setEntries((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });
    }, FLUSH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      pendingRef.current = [];
      es.close();
    };
  }, [open, scope, logsEndpoint, currentAppKey]);

  // Keep the view pinned to the latest entry unless the user scrolled up.
  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, pinned]);

  const visible = entries.filter((entry) => {
    if (levelFilter === "error") {
      const level = entry.level.toLowerCase();
      if (level !== "error" && level !== "fault") return false;
    }
    if (textFilter) {
      const needle = textFilter.toLowerCase();
      if (
        !entry.message.toLowerCase().includes(needle) &&
        !entry.process.toLowerCase().includes(needle) &&
        !entry.subsystem.toLowerCase().includes(needle)
      ) return false;
    }
    return true;
  });

  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        <PanelTitle>Logs</PanelTitle>
        <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
          <input
            type="text"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter log messages"
            className="w-[120px] min-w-0 rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[11px] text-white/90 placeholder:text-white/40 outline-none focus:border-white/30"
          />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as "all" | "error")}
            aria-label="Filter by log level"
            className="rounded-md border border-white/12 bg-white/5 px-1.5 py-1 text-[11px] text-white/90 outline-none"
          >
            <option value="all">All levels</option>
            <option value="error">Errors</option>
          </select>
          <button
            type="button"
            onClick={() => { setScope((s) => (s === "app" ? "system" : "app")); setEntries([]); }}
            aria-pressed={scope === "app"}
            title={scope === "app" ? "Showing foreground app logs" : "Showing full system log"}
            className="rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[11px] text-white/90 cursor-pointer hover:bg-white/10"
          >
            {scope === "app" ? "App" : "System"}
          </button>
          <button
            type="button"
            onClick={() => { setEntries([]); pendingRef.current = []; }}
            title="Clear"
            className="rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[11px] text-white/90 cursor-pointer hover:bg-white/10"
          >
            Clear
          </button>
        </div>
        <PanelCloseButton onClick={onClose} ariaLabel="Close logs" title="Close" iconSize={15} />
      </PanelHeader>

      {streamError && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-[#ffb86c] bg-white/4 border-b border-white/8">
          {streamError}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[1.6] bg-panel-deep"
      >
        {visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-white/[0.45] text-center text-[12px] [font-family:-apple-system,system-ui,sans-serif]">
            {entries.length === 0
              ? "Waiting for logs… (logs appear from the moment this panel opens)"
              : "No entries match the current filter."}
          </div>
        ) : (
          visible.map((entry, i) => (
            <div key={i} className="whitespace-pre-wrap break-words" style={{ color: levelColor(entry.level) }}>
              {formatLogEntry(entry)}
            </div>
          ))
        )}
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-3 right-3 rounded-full border border-white/15 bg-panel px-3 py-1.5 text-[11px] text-white/90 shadow-[0_4px_12px_rgba(0,0,0,0.4)] cursor-pointer hover:bg-white/10"
        >
          ↓ Latest
        </button>
      )}
    </Panel>
  );
}
```

- [ ] **Step 3: Wire it into `client.tsx`**

All in `packages/serve-sim/src/client/client.tsx`:

a. Imports — add to the existing component/util imports:

```typescript
import { LogsPanel } from "./components/logs-panel";
```
and add `LOGS_PANEL_WIDTH` to the existing `panel-widths` import.

b. State (next to `devtoolsOpen`/`gridOpen`, ~line 97):

```typescript
const [logsOpen, setLogsOpen] = useState(false);
```

c. Width hook (next to the other `useResizableWidth` calls, ~line 497):

```typescript
const { width: logsPanelWidth, onPointerDown: onLogsResize } = useResizableWidth(
  "serve-sim:logs-panel-width",
  LOGS_PANEL_WIDTH,
  380,
  1200,
);
```

d. Shift calculation (~line 680) — add `logsOpen` to the chain:

```typescript
const panelWidthPx = devtoolsOpen
  ? devtoolsPanelWidth
  : gridOpen
  ? gridPanelWidth
  : logsOpen
  ? logsPanelWidth
  : panelOpen
  ? toolsPanelWidth
  : 0;
```

e. Sidebar rail (~line 898): include `logsOpen` in the hide condition:

```typescript
${(panelOpen || devtoolsOpen || gridOpen || logsOpen) ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}
```

Each of the three existing rail buttons' `onClick` additionally closes the logs panel — add `setLogsOpen(false);` alongside their existing `setXxxOpen(false)` calls. Then add a fourth button after the grid button (~line 950):

```tsx
<button
  onClick={() => {
    setPanelOpen(false);
    setDevtoolsOpen(false);
    setGridOpen(false);
    setLogsOpen((o) => !o);
  }}
  className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
  aria-label="Open logs panel"
  aria-pressed={logsOpen}
  title="Logs"
>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 17l4-4-4-4" />
    <line x1="11" y1="19" x2="20" y2="19" />
  </svg>
</button>
```

f. Panel + resize handle (after the `WebKitDevtoolsPanel` block, ~line 999):

```tsx
<LogsPanel
  open={logsOpen}
  onClose={() => setLogsOpen(false)}
  logsEndpoint={config.logsEndpoint ?? simEndpoint("logs")}
  currentAppKey={currentApp?.bundleId ?? null}
  width={logsPanelWidth}
/>
<ResizeHandle
  panelWidth={logsPanelWidth}
  visible={logsOpen}
  onPointerDown={onLogsResize}
  ariaLabel="Resize logs panel"
/>
```

(`simEndpoint` is already imported in client.tsx — it is used for the appstate fallback at line 518.)

The existing DevTools-console log streaming effect (lines 141–209) stays untouched — agent-browser reads page console messages, so it has standalone value.

- [ ] **Step 4: Typecheck, lint, full unit suite**

Run: `bun run typecheck && bun run lint && bun test packages/serve-sim-client packages/serve-sim/src/__tests__ --timeout 60000`
Expected: clean, all pass

- [ ] **Step 5: Commit**

```bash
git add packages/serve-sim/src/client/components/logs-panel.tsx packages/serve-sim/src/client/utils/panel-widths.ts packages/serve-sim/src/client/client.tsx
git commit -m "feat: ✨ WebUIにログパネルを追加(SSE購読・フィルタ・自動スクロール)"
```

---

### Task 7: CLI e2e test

**Files:**
- Create: `packages/serve-sim/src/__tests__/logs.e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

Follows the `permissions.e2e.test.ts` pattern: drives the **built** CLI, skips when no booted iOS sim or no `dist/serve-sim.js`.

```typescript
import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");

function bootedUdid(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devices) if (d.state === "Booted") return d.udid;
    }
  } catch {}
  return null;
}

const udid = bootedUdid();
// Needs both a booted iOS sim and the built CLI (`bun run build.ts` first).
const describeIfSim = udid && existsSync(CLI) ? describe : describe.skip;

function cli(...args: string[]): string {
  return execFileSync("node", [CLI, "logs", "-d", udid!, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
}

describeIfSim("serve-sim logs (e2e)", () => {
  test("--system --last returns formatted lines", () => {
    const out = cli("--system", "--last", "30s");
    const lines = out.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // "07:47:07.934 DEFAULT systemsoundserver-simd: ..."
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \S+\s+\S+.*: /);
  });

  test("--json returns parseable NDJSON", () => {
    const out = cli("--system", "--last", "30s", "--json");
    const lines = out.trim().split("\n").filter((l) => l.trim().startsWith("{"));
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]!) as { eventMessage?: string };
    expect(typeof entry.eventMessage).toBe("string");
  });

  test("--last with --follow exits non-zero", () => {
    expect(() => cli("--last", "1m", "--follow")).toThrow();
  });

  test("rejects an invalid --last duration", () => {
    expect(() => cli("--system", "--last", "nope")).toThrow();
  });
});
```

- [ ] **Step 2: Build the CLI and run the test**

Run: `cd packages/serve-sim && bun run build.ts && bun test src/__tests__/logs.e2e.test.ts --timeout 120000`
Expected: PASS with a booted simulator (or `describe.skip` without one — run with one booted)

- [ ] **Step 3: Commit**

```bash
git add packages/serve-sim/src/__tests__/logs.e2e.test.ts
git commit -m "test: ✅ serve-sim logsのe2eテストを追加"
```

---

### Task 8: Docs — skills/serve-sim references

**Files:**
- Modify: `skills/serve-sim/SKILL.md`
- Modify: `skills/serve-sim/references/endpoints.md`

- [ ] **Step 1: Document the CLI command in SKILL.md**

Read `skills/serve-sim/SKILL.md` first and add a `logs` entry alongside the existing subcommand list (tap/gesture/button/camera), matching its tone and format:

```markdown
- `serve-sim logs [-d udid]` — simulator logs. Default: last 1m of the
  foreground app. `--last 30s` to change the window, `-f` to follow live,
  `--app <bundleId>` / `--system` to change scope, `--json` for raw NDJSON.
  Typical agent flow: `serve-sim tap 0.5 0.9 && serve-sim logs --last 30s`.
```

- [ ] **Step 2: Document the endpoint params in references/endpoints.md**

Read `skills/serve-sim/references/endpoints.md` first and extend its `/logs` entry:

```markdown
- `GET {base}/logs` — SSE of `simctl log stream` NDJSON entries.
  - `?scope=app` filters to the foreground app (resolved at connect time;
    reconnect to re-resolve). `?scope=system` / no param = unfiltered.
  - `?level=default|info|debug` (default: `info`).
  - On scope-resolution failure: `event: error` + falls back to the system
    stream. On spawn failure: `event: error` + the stream closes.
```

- [ ] **Step 3: Commit**

```bash
git add skills/serve-sim/SKILL.md skills/serve-sim/references/endpoints.md
git commit -m "docs: 📝 serve-sim logsコマンドと/logsクエリパラメータを文書化"
```

---

### Task 9: End-to-end verification (browser + CLI)

**Files:** none (verification only)

- [ ] **Step 1: Full build + full test suite**

```bash
bun run packages/serve-sim/build.ts
bun run typecheck && bun run lint
bun test packages/serve-sim-client packages/serve-sim/src/__tests__ --timeout 120000
```
Expected: all clean / all pass.

- [ ] **Step 2: Live server smoke**

```bash
node packages/serve-sim/dist/serve-sim.js --detach --port 3399
node packages/serve-sim/dist/serve-sim.js logs --last 1m | head -20   # foreground-app default path
```
Expected: `logs` with no flags resolves the foreground app via the helper and prints its entries.

- [ ] **Step 3: Web UI smoke via agent-browser**

```bash
agent-browser open http://localhost:3399
agent-browser snapshot          # find the "Open logs panel" button ref
agent-browser click @eN         # open the panel
# interact with the simulator (e.g. serve-sim tap 0.5 0.5), wait ~2s
agent-browser screenshot /tmp/logs-panel.png
```
Expected: panel shows log rows; the App/System toggle switches the stream; Clear empties it. Check the screenshot.

- [ ] **Step 4: Kill the server**

```bash
node packages/serve-sim/dist/serve-sim.js -k
```

---

## Self-Review (done at plan time)

- **Spec coverage:** shared module → Tasks 1–3; CLI incl. defaults/exclusivity/error paths → Task 4; server `scope`/`level` + error fallback → Task 5; LogsPanel (buffer 2000, filters, scope toggle, auto-scroll, live-only, console logging kept) → Task 6; predicate escaping → Task 1; e2e → Tasks 7/9; docs → Task 8.
- **Out of scope (per spec):** panel backfill, `-f --last` combination, server-side re-predicating on app switch.
- **Type consistency:** `LogEntry`/`LogLevel`/`ListedApp` defined once in `logs.ts`; exec wrappers in `logs-exec.ts`; client imports only pure code from `logs.ts`.
