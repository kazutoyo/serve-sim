# serve-sim WebUI: Screenshot & Screen Recording

Date: 2026-06-06
Status: Approved

## Goal

Add screenshot and screen-recording capabilities to serve-sim, usable both by
humans in the web UI and by agents/scripts via the CLI. Captures are always
saved to a predictable directory on the host; the web UI additionally copies
screenshots to the clipboard (or downloads as a fallback) and downloads
recordings.

## Background

The component library (`serve-sim-client`) ships a `ScreenshotButton`, but it
was removed from the preview toolbar in `b7142b0` and never re-added. Its
implementation runs `simctl io screenshot ~/Desktop/...` on the host with no
browser feedback — the button appears to do nothing and silently litters the
Desktop. This feature is the proper re-implementation.

## Approach

Server-side capture via `xcrun simctl io`, managed by the Node middleware.
Chosen over (a) muxing the existing H.264 stream in the Swift helper (more
work, recording would break across helper re-injection) and (b) browser-side
`MediaRecorder` (stream-quality WebM only, host save would need an upload).
`simctl io` gives native-resolution PNG/MP4 with one implementation serving
both the web UI and the CLI.

## Server (packages/serve-sim/src/middleware.ts)

New endpoints, following the existing `/grid/api/*` patterns. Each accepts an
optional `udid` (JSON body), defaulting to the server's active device:

- `POST /api/screenshot` — runs
  `xcrun simctl io <udid> screenshot <captures-dir>/<timestamp>.png`,
  responds `{ path, url }`. `url` points at `GET /api/captures/<file>`.
- `POST /api/record/start` — spawns
  `xcrun simctl io <udid> recordVideo --codec h264 <captures-dir>/<timestamp>.mp4`.
  One active recording per device; a second start returns 409.
- `POST /api/record/stop` — sends SIGINT to the recorder child, waits for it
  to exit (simctl finalizes the moov atom on SIGINT), responds `{ path, url }`.
- `GET /api/record/status` — `{ recording, path, startedAt }`.
- `GET /api/captures/<file>` — serves a file from the captures dir.
  Filenames are server-generated timestamps; client-supplied paths are never
  accepted (no path traversal).

Captures directory:

- CLI flag `--captures-dir <dir>`; default `./serve-sim-captures/` under the
  server's cwd, created on first use.

Lifecycle:

- Recording continues across browser disconnects; only an explicit stop ends it.
- On server process exit, any active recorder child gets SIGINT so the MP4 is
  finalized rather than truncated.
- If the device shuts down mid-recording, the simctl child exits; the server
  detects this, resets recording state, and keeps the partial MP4.

## Web UI (packages/serve-sim/src/client/client.tsx)

Two buttons added to the toolbar next to Home / AX / Rotate, using the
existing `SimulatorToolbar.Button`, with the same disable rules (no device,
not streaming, gateway disconnected):

- **Screenshot** (camera icon): calls `POST /api/screenshot`, then fetches
  the PNG from `url` and:
  - secure context (localhost): copies to clipboard via
    `navigator.clipboard.write([ClipboardItem])`, toast
    "Copied to clipboard (saved to <path>)".
  - non-secure context (LAN IP) or clipboard failure: triggers a browser
    download instead, toast shows the host path.
- **Record toggle** (● icon): click to start; while recording the button is
  red with elapsed time; click again to stop, then auto-download the MP4 and
  toast the host path. State is re-synced from `GET /api/record/status` on
  page load so a reload doesn't orphan the UI.

## CLI (packages/serve-sim/src/index.ts)

Thin wrappers over the endpoints, discovering the server via the existing
`readState()`:

- `serve-sim screenshot [-o <path>] [-d udid]` — prints the saved host path;
  with `-o`, fetches the capture and writes it there instead.
- `serve-sim record start [-d udid]` / `record stop [-d udid]` /
  `record status [-d udid]` — `stop` prints the saved MP4 path.

## Error handling

- Device not booted / simctl failure → 4xx/5xx JSON including stderr; web UI
  shows it in a toast, CLI prints to stderr and exits non-zero.
- Double `record start` → 409; `record stop` with no active recording → 404.

## Testing (TDD)

- Unit (vitest): captures-dir resolution, filename generation, and the
  recording state machine (start / stop / double-start / child-exit) extracted
  as pure logic.
- E2E (existing CLI-driven flow): boot a simulator, start the server, run
  `serve-sim screenshot` and assert the PNG exists; `record start` → tap →
  `record stop` and assert the MP4 exists with nonzero size.
