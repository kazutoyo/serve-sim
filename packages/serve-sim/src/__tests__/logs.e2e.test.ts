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
  // A 10s window keeps these tests fast and bounded: on a freshly booted CI
  // simulator the archive is dominated by boot spew, and a 2m window made
  // `log show` overrun bun's default 5s test timeout while the raw NDJSON
  // blew through execFileSync's 64MB maxBuffer (ENOBUFS). Even an idle sim
  // logs hundreds of system entries per 10s, so the window is never empty.
  // The explicit per-test timeout covers slow CI runners.
  test("--system --last returns formatted lines", () => {
    const out = cli("--system", "--last", "10s");
    const lines = out.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // "07:47:07.934 DEFAULT systemsoundserver-simd: ..."
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \S+\s+\S+.*: /);
  }, 60_000);

  test("--json returns parseable NDJSON", () => {
    const out = cli("--system", "--last", "10s", "--json");
    const lines = out.trim().split("\n").filter((l) => l.trim().startsWith("{"));
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]!) as { eventMessage?: string };
    expect(typeof entry.eventMessage).toBe("string");
  }, 60_000);

  test("--last with --follow exits non-zero", () => {
    expect(() => cli("--last", "1m", "--follow")).toThrow();
  });

  test("rejects an invalid --last duration", () => {
    expect(() => cli("--system", "--last", "nope")).toThrow();
  });
});
