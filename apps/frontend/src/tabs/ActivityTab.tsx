import type { DashboardSummary, StockEvent } from "@smart-db/contracts";
import { actionLabel, formatTimestamp } from "../SmartApp.helpers";

export interface ScanHistoryEntry {
  code: string;
  mode: string;
  timestamp: string;
}

interface ActivityTabProps {
  dashboard: DashboardSummary | null;
  partDbStatus: unknown;
  scanHistory: ScanHistoryEntry[];
}

function describeEvent(e: StockEvent): { title: string; item: string | null; detail: string; time: string } {
  const action = actionLabel(e.event);
  const who = e.actor ?? "system";

  let detail = "";
  if (e.toState && e.fromState) {
    detail = `${e.fromState} → ${e.toState}`;
  } else if (e.toState) {
    detail = e.toState;
  }

  if (e.location) {
    detail = detail ? `${detail} · ${e.location}` : e.location;
  }

  return {
    title: `${action} by ${who}`,
    item: e.partName ?? null,
    detail,
    time: formatTimestamp(e.createdAt),
  };
}

function scanModeLabel(mode: string): string {
  switch (mode) {
    case "interact": return "opened";
    case "label": return "ready to assign";
    case "unknown": return "unregistered";
    default: return mode;
  }
}

export function ActivityTab(props: ActivityTabProps) {
  const events = props.dashboard?.recentEvents ?? [];
  const hasEvents = events.length > 0;
  const hasScans = props.scanHistory.length > 0;

  return (
    <section className="panel">
      <header className="activity-header">
        <p className="eyebrow">Activity</p>
        <h2>Recent events</h2>
      </header>

      {!hasEvents && !hasScans ? (
        <p className="activity-empty">
          No activity yet. Events appear here as you scan and update inventory.
        </p>
      ) : null}

      {hasEvents ? (
        <ul className="activity-list">
          {events.map((e) => {
            const info = describeEvent(e);
            return (
              <li key={e.id} className="activity-item">
                <div className="activity-item-header">
                  <span className="activity-action">{info.title}</span>
                  <span className="activity-time">{info.time}</span>
                </div>
                {info.item ? <span className="activity-item-name">{info.item}</span> : null}
                {info.detail ? (
                  <span className="activity-detail">{info.detail}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {hasScans ? (
        <>
          <h3 className="activity-section-title">This session</h3>
          <ul className="activity-list">
            {props.scanHistory.map((entry, i) => (
              <li key={`${entry.code}-${i}`} className="activity-item">
                <div className="activity-item-header">
                  <code className="activity-code">{entry.code}</code>
                  <span className="activity-time">{formatTimestamp(entry.timestamp)}</span>
                </div>
                <span className="activity-detail">{scanModeLabel(entry.mode)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
