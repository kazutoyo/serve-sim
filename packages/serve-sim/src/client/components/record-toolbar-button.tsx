import { useEffect, useState } from "react";
import { SimulatorToolbar } from "serve-sim-client/simulator";
import {
  captureBasename,
  downloadFile,
  recordingStatus,
  startRecording,
  stopRecording,
} from "../utils/captures";

type RecordingInfo = { path: string; startedAt: number };

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const RecordIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </svg>
);

const StopIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </svg>
);

export function RecordToolbarButton({
  udid,
  onResult,
}: {
  udid: string | null;
  onResult: (ok: boolean, message: string) => void;
}) {
  const [recording, setRecording] = useState<RecordingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Re-render every second while recording so the elapsed label ticks.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // Sync with a recording started before this page load (or from the CLI).
  useEffect(() => {
    if (!udid) return;
    let cancelled = false;
    recordingStatus(udid).then((s) => {
      if (cancelled) return;
      setRecording(s.recording && s.path && s.startedAt ? { path: s.path, startedAt: s.startedAt } : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [udid]);

  const handleClick = async () => {
    if (!udid || busy) return;
    setBusy(true);
    try {
      if (recording) {
        const r = await stopRecording(udid);
        setRecording(null);
        if (r.ok && r.path && r.url) {
          downloadFile(r.url, captureBasename(r.path));
          onResult(true, `Saved recording to ${r.path}`);
        } else {
          onResult(false, r.error ?? "Failed to stop recording");
        }
      } else {
        const r = await startRecording(udid);
        if (r.ok && r.path && r.startedAt) {
          setRecording({ path: r.path, startedAt: r.startedAt });
        } else {
          onResult(false, r.error ?? "Failed to start recording");
        }
      }
    } catch (err) {
      onResult(false, err instanceof Error ? err.message : "Recording request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SimulatorToolbar.Button
      aria-label={recording ? "Stop recording" : "Start recording"}
      title={recording ? `Recording ${formatElapsed(now - recording.startedAt)} — click to stop` : "Record screen"}
      aria-pressed={!!recording}
      onClick={() => void handleClick()}
      style={recording ? { color: "#f87171" } : undefined}
    >
      {recording ? StopIcon : RecordIcon}
    </SimulatorToolbar.Button>
  );
}
