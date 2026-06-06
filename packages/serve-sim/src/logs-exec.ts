import { execFileSync, execFile } from "child_process";
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
 * Async variant of `resolveAppProcess` for the middleware, which resolves
 * after the SSE response is committed — execFileSync there would block the
 * host dev server's event loop for the duration of the listapps + plutil run.
 */
export function resolveAppProcessAsync(
  udid: string,
  bundleId: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "xcrun", ["simctl", "listapps", udid],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      (err, plist) => {
        if (err) return resolve(null);
        const child = execFile(
          "plutil", ["-convert", "json", "-o", "-", "--", "-"],
          { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
          (err2, json) => {
            if (err2) return resolve(null);
            try {
              resolve(findExecutableForBundle(
                JSON.parse(json) as Record<string, ListedApp>,
                bundleId,
              ));
            } catch {
              resolve(null);
            }
          },
        );
        child.stdin!.end(plist);
      },
    );
  });
}

/**
 * Frontmost app via the running Swift helper's `/foreground` probe.
 * Null when the helper is unreachable or reports no foreground app.
 */
export async function fetchForegroundApp(
  port: number,
): Promise<{ bundleId: string; pid: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/foreground`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { bundleId?: string; pid?: number };
    if (typeof data.bundleId !== "string" || data.bundleId === "") return null;
    return { bundleId: data.bundleId, pid: typeof data.pid === "number" ? data.pid : 0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
