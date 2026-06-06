import { simEndpoint } from "./sim-endpoint";

export interface CaptureResult {
  ok: boolean;
  path?: string;
  url?: string;
  startedAt?: number;
  error?: string;
}

export interface RecordingStatusResult {
  recording: boolean;
  path?: string;
  startedAt?: number;
}

async function postJson(path: string, body: object): Promise<CaptureResult> {
  const res = await fetch(simEndpoint(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as CaptureResult;
}

export const takeScreenshot = (udid: string) => postJson("api/screenshot", { udid });
export const startRecording = (udid: string) => postJson("api/record/start", { udid });
export const stopRecording = (udid: string) => postJson("api/record/stop", { udid });

export async function recordingStatus(udid: string): Promise<RecordingStatusResult> {
  const res = await fetch(simEndpoint(`api/record/status?udid=${encodeURIComponent(udid)}`));
  return (await res.json()) as RecordingStatusResult;
}

/**
 * Copy the PNG at `url` to the clipboard. Returns false when the Clipboard
 * API is unavailable (non-secure context — e.g. the preview opened via a LAN
 * IP) or the write fails; callers fall back to a download.
 */
export async function copyImageToClipboard(url: string): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return false;
  }
  try {
    // Pass the promise straight into ClipboardItem: Safari requires the
    // clipboard write to stay within the user-gesture call stack.
    const item = new ClipboardItem({
      "image/png": fetch(url).then((r) => r.blob()),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}

/** Trigger a browser download of `url` named `filename`. */
export function downloadFile(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Last path segment of a host path, for toast text / download names. */
export function captureBasename(path: string): string {
  return path.split("/").pop() ?? path;
}
