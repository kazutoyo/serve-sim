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
