// packages/serve-sim/src/__tests__/capture-endpoints.test.ts
import { describe, expect, test } from "bun:test";
import { createServer } from "http";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { simMiddleware } from "../middleware";
import { recordingStateFile, writeRecordingState } from "../captures";

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

  test("GET /api/record/status with no udid falls back to selected device", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/api/record/status`);
      // No helper running → 404 (No serve-sim device). On a dev machine with
      // a live helper it's 200 with a status JSON. Invariant: JSON, no crash.
      expect([200, 404]).toContain(r.status);
      const body = await r.json() as Record<string, unknown>;
      expect(body).toBeTruthy();
    });
  });

  test("POST /api/record/start while already recording → 409 with path", async () => {
    const udid = "00000000-0000-0000-0000-00000000A409";
    writeRecordingState(udid, { pid: process.pid, path: "/tmp/fake-recording.mp4", startedAt: 1 });
    try {
      await withServer(async (origin) => {
        const r = await fetch(`${origin}/api/record/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        expect(r.status).toBe(409);
        const body = await r.json() as { ok: boolean; error: string; path: string };
        expect(body.ok).toBe(false);
        expect(body.path).toBe("/tmp/fake-recording.mp4");
        expect(body.error).toContain("Already recording");
      });
    } finally {
      rmSync(recordingStateFile(udid), { force: true });
    }
  });
});

describe("GET /api/captures/<file>", () => {
  test("serves an existing capture with the right content-type", async () => {
    writeFileSync(join(CAPTURES_DIR, "screenshot-20260606-000000-000.png"), "fakepng");
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/api/captures/screenshot-20260606-000000-000.png`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(r.headers.get("content-disposition")).toBe(
        'attachment; filename="screenshot-20260606-000000-000.png"',
      );
      expect(await r.text()).toBe("fakepng");
    });
  });

  test("serves a recording with video/mp4 content-type", async () => {
    writeFileSync(join(CAPTURES_DIR, "recording-20260606-000000-000.mp4"), "fakemp4");
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/api/captures/recording-20260606-000000-000.mp4`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("video/mp4");
      expect(r.headers.get("content-disposition")).toBe(
        'attachment; filename="recording-20260606-000000-000.mp4"',
      );
      expect(await r.text()).toBe("fakemp4");
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
