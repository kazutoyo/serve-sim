import { useEffect, useRef, useState } from "react";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { formatLogEntry, parseLogLine, type LogEntry } from "../../logs";

const MAX_ENTRIES = 2000;
const FLUSH_INTERVAL_MS = 250;

function levelColor(level: string): string {
  switch (level.toLowerCase()) {
    case "error":
    case "fault":
      return "#ff5555";
    case "debug":
      return "#6272a4";
    default:
      return "rgba(255,255,255,0.85)";
  }
}

export function LogsPanel({
  open,
  onClose,
  logsEndpoint,
  currentAppKey,
  width,
}: {
  open: boolean;
  onClose: () => void;
  /** `{base}/logs?device=...` from the preview config. */
  logsEndpoint: string;
  /** Foreground bundle id; a change re-subscribes so scope=app re-resolves. */
  currentAppKey: string | null;
  width: number;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [scope, setScope] = useState<"app" | "system">("app");
  const [levelFilter, setLevelFilter] = useState<"all" | "error">("all");
  const [textFilter, setTextFilter] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<LogEntry[]>([]);

  // Subscribe to the SSE stream while the panel is open. Scope toggles and
  // foreground-app changes re-run this effect → fresh connection with the
  // newly-resolved predicate (the server resolves scope at connect time).
  useEffect(() => {
    if (!open) return;
    setStreamError(null);
    const sep = logsEndpoint.includes("?") ? "&" : "?";
    const es = new EventSource(`${logsEndpoint}${sep}scope=${scope}`);
    es.onmessage = (event) => {
      const entry = parseLogLine(event.data);
      if (entry) pendingRef.current.push(entry);
    };
    es.addEventListener("error", (event) => {
      // Server-sent `event: error` carries a message; transport errors don't.
      const data = (event as MessageEvent).data as string | undefined;
      if (data) {
        try { setStreamError((JSON.parse(data) as { message?: string }).message ?? "Log stream error"); } catch {}
      }
    });
    const timer = setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
      setEntries((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });
    }, FLUSH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      pendingRef.current = [];
      es.close();
    };
  }, [open, scope, logsEndpoint, currentAppKey]);

  // Keep the view pinned to the latest entry unless the user scrolled up.
  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, pinned]);

  const visible = entries.filter((entry) => {
    if (levelFilter === "error") {
      const level = entry.level.toLowerCase();
      if (level !== "error" && level !== "fault") return false;
    }
    if (textFilter) {
      const needle = textFilter.toLowerCase();
      if (
        !entry.message.toLowerCase().includes(needle) &&
        !entry.process.toLowerCase().includes(needle) &&
        !entry.subsystem.toLowerCase().includes(needle)
      ) return false;
    }
    return true;
  });

  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        <PanelTitle>Logs</PanelTitle>
        <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
          <input
            type="text"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter log messages"
            className="w-[120px] min-w-0 rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[11px] text-white/90 placeholder:text-white/40 outline-none focus:border-white/30"
          />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as "all" | "error")}
            aria-label="Filter by log level"
            className="rounded-md border border-white/12 bg-white/5 px-1.5 py-1 text-[11px] text-white/90 outline-none"
          >
            <option value="all">All levels</option>
            <option value="error">Errors</option>
          </select>
          <button
            type="button"
            onClick={() => { setScope((s) => (s === "app" ? "system" : "app")); setEntries([]); }}
            aria-pressed={scope === "app"}
            title={scope === "app" ? "Showing foreground app logs" : "Showing full system log"}
            className="rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[11px] text-white/90 cursor-pointer hover:bg-white/10"
          >
            {scope === "app" ? "App" : "System"}
          </button>
          <button
            type="button"
            onClick={() => { setEntries([]); pendingRef.current = []; }}
            title="Clear"
            className="rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[11px] text-white/90 cursor-pointer hover:bg-white/10"
          >
            Clear
          </button>
        </div>
        <PanelCloseButton onClick={onClose} ariaLabel="Close logs" title="Close" iconSize={15} />
      </PanelHeader>

      {streamError && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-[#ffb86c] bg-white/4 border-b border-white/8">
          {streamError}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[1.6] bg-panel-deep"
      >
        {visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-white/[0.45] text-center text-[12px] [font-family:-apple-system,system-ui,sans-serif]">
            {entries.length === 0
              ? "Waiting for logs… (logs appear from the moment this panel opens)"
              : "No entries match the current filter."}
          </div>
        ) : (
          visible.map((entry, i) => (
            <div key={i} className="whitespace-pre-wrap break-words" style={{ color: levelColor(entry.level) }}>
              {formatLogEntry(entry)}
            </div>
          ))
        )}
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-3 right-3 rounded-full border border-white/15 bg-panel px-3 py-1.5 text-[11px] text-white/90 shadow-[0_4px_12px_rgba(0,0,0,0.4)] cursor-pointer hover:bg-white/10"
        >
          ↓ Latest
        </button>
      )}
    </Panel>
  );
}
