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
