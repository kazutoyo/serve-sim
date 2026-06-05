# serve-sim: Simulator Log Access for Web UI and Agents

Date: 2026-06-06
Status: Approved

## Goal

Make simulator logs easy to read for both agents (via a `serve-sim logs` CLI
subcommand) and humans (via a Logs panel in the web UI). Default to the
foreground app's process logs — the signal a developer debugging their app
actually wants — with an opt-in to the full system log.

## Background

The plumbing half-exists today:

- `GET {basePath}/logs` (middleware.ts) is an SSE endpoint that spawns
  `xcrun simctl spawn <udid> log stream --style ndjson --level info` and
  forwards every NDJSON line. It is unfiltered: SpringBoard, daemons, and
  every other process on the simulator flood the stream.
- The web client subscribes to it (client.tsx) but only writes entries to the
  **browser DevTools console** with colors and grouping. There is no in-page
  log UI.
- There is no CLI access at all, and no way to look *backwards* — by the time
  you notice a crash, the interesting lines have already streamed past
  (or were never captured because nothing was subscribed).

## Approach

On-demand `simctl` invocations, no server-side buffering:

- **Snapshots** via `xcrun simctl spawn <udid> log show --last <duration>
  --style ndjson`. The OS keeps its own log archive, so "what just happened?"
  works even if no stream was running and even if the serve-sim server is not
  running.
- **Live follow** via the existing `log stream`, extended with a predicate.

Chosen over (a) a server-side ring buffer fed by an always-on `log stream`
(constant CPU cost, extra state, and useless when the server isn't running —
`log show` covers the same need from the OS archive) and (b) a web-UI-only
log panel (doesn't serve agents).

Trade-off accepted: `log show` scans the archive and can take a few seconds.
Fine for the agent workflow (`tap` → `logs --last 30s`).

## Shared module (packages/serve-sim/src/logs.ts)

One module used by both the CLI and the middleware:

- `LogEntry` type: `{ timestamp, level, process, pid, subsystem, category,
  message }`, parsed from simctl's NDJSON fields (`eventMessage`,
  `messageType`, `processImagePath`, …).
- `buildLogShowArgs(opts)` / `buildLogStreamArgs(opts)` — assemble simctl
  argv from `{ udid, last?, level, predicate? }`.
- `buildProcessPredicate(processName)` — returns
  `process == "<name>"` with the name escaped (quotes/backslashes) so a
  hostile app name can't inject predicate syntax.
- `parseLogLine(line): LogEntry | null` — tolerant of non-JSON lines
  (simctl prints headers/noise on some OS versions).
- `formatLogEntry(entry): string` — `HH:MM:SS.mmm LEVEL process: message`
  for human/agent-readable output.
- `resolveAppProcess(udid, bundleId)` — executable name from
  `simctl listapps` (predicates match process names, not bundle IDs).
- `resolveForegroundApp(udid)` — reads the state file
  (`~/.serve-sim/<udid>.json`) and asks the helper's `GET /foreground` for
  `{ bundleId, pid }`. Only available while the server/helper is running.

## CLI: `serve-sim logs`

```
serve-sim logs [-d udid] [options]
  --last <duration>    snapshot via `log show` (e.g. 30s, 2m). Default: 1m
  -f, --follow         live tail via `log stream` (mutually exclusive with --last in v1)
  --app <bundleId>     filter to this app's process
  --system             no process filter (full system log)
  --level <level>      default | info | debug (default: info)
  --json               raw NDJSON output (default: formatted text)
```

- **Default invocation** (`serve-sim logs`): last 1 minute of the foreground
  app's logs. This alone completes the agent loop "do something → check logs".
- **Scope resolution**: `--app` and `--system` are explicit. With neither,
  resolve the foreground app via the running helper; if no helper is running,
  exit with an error telling the user to pass `--app <bundleId>` or
  `--system`.
- simctl is spawned directly by the CLI — the server is not in the path, so
  `--app`/`--system` work with nothing else running (booted device required).

## Server: extend `GET {basePath}/logs`

Query parameters, backward compatible (no params = today's behavior:
unfiltered system stream):

- `?scope=app` — resolve the foreground app at connect time and add a
  process predicate to `log stream`. `?scope=system` or absent = unfiltered.
- `?level=info|debug` — passed through to `--level`.
- Foreground app changes do **not** re-predicate an open stream. The client
  already has `{basePath}/appstate` (SSE of foreground changes); the Logs
  panel reconnects with the new scope when the app changes.
- If `scope=app` is requested and no foreground app can be resolved, the
  endpoint emits an SSE `event: error` with a message and falls back to the
  system stream (the panel shows the error and the toggle state).

## Web UI: LogsPanel

A new panel following the existing panel patterns (WebKitDevtoolsPanel,
ToolsPanel), toggled from the toolbar:

- **Rows**: time + level color + process name + message. Level colors follow
  the existing console palette; no low-opacity icons.
- **Controls**: free-text filter, level filter, app/system scope toggle
  (default: app), clear button.
- **Buffer**: 2,000 entries max, oldest dropped.
- **Auto-scroll**: pinned to bottom; scrolling up pauses, a "jump to latest"
  button re-pins.
- **Live only in v1**: the panel shows logs from the moment it opens.
  Backfill ("--last for the panel") is deferred; the CLI covers that need.
- The existing DevTools-console logging in client.tsx stays — agent-browser
  reads page console messages, so it has standalone value.

## Error handling

- Device not booted / simctl spawn failure: CLI prints a clear error and
  exits non-zero; the SSE endpoint emits `event: error` before closing.
- Predicate strings are escaped in one place (`buildProcessPredicate`).
- Partial/garbage NDJSON lines are skipped by `parseLogLine`, never crash
  the stream. The existing SSE line-buffer cap stays.

## Testing

- **Unit (TDD)**: `logs.test.ts` drives `buildLogShowArgs`,
  `buildLogStreamArgs`, `buildProcessPredicate` (incl. escaping),
  `parseLogLine` (real simctl NDJSON samples + garbage lines), and
  `formatLogEntry`.
- **E2E** (booted simulator): `serve-sim logs --last 1m --system` returns
  formatted lines; `--json` returns parseable NDJSON; the web UI panel is
  exercised via agent-browser (open panel, observe rows, toggle scope).
