import { describe, expect, test } from "bun:test";
import {
  buildLogShowArgs,
  buildLogStreamArgs,
  buildProcessPredicate,
  findExecutableForBundle,
  formatLogEntry,
  isValidLastDuration,
  parseLogLine,
  type LogEntry,
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
