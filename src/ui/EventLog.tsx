import type { LogEntry } from './types.ts';

const ZONE_COLOUR: Record<string, string> = {
  upperLeft: 'var(--violet)',
  upperRight: 'var(--cyan)',
  lowerLeft: 'var(--gold)',
  lowerRight: 'var(--pink)',
};

const SHORT_ZONE: Record<string, string> = {
  upperLeft: 'UL',
  upperRight: 'UR',
  lowerLeft: 'LL',
  lowerRight: 'LR',
};

export default function EventLog({ entries }: { entries: readonly LogEntry[] }) {
  if (entries.length === 0) {
    return <p className="log__empty">No events yet. Move a wrist into a zone.</p>;
  }

  return (
    <div className="log mono" style={{ marginTop: 8 }}>
      {entries.map((entry) => {
        const isEnter = entry.type === 'ZONE_ENTER';
        return (
          <div key={entry.id} className={`log__row ${isEnter ? '' : 'log__row--exit'}`}>
            <span className="log__time">{(entry.timestampMs / 1000).toFixed(2)}s</span>
            <span style={{ color: ZONE_COLOUR[entry.zoneId] }}>
              {isEnter ? '▶' : '□'} {SHORT_ZONE[entry.zoneId] ?? entry.zoneId}{' '}
              {entry.limb === 'leftWrist' ? 'L' : 'R'}
            </span>
            <span className="log__meta">
              {isEnter ? `+${entry.latencyMs.toFixed(0)}ms` : `${entry.dwellMs?.toFixed(0)}ms held`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
