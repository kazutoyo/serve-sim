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
