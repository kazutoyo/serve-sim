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
