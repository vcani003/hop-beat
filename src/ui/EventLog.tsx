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
        const isBlocked = entry.type === 'ZONE_BLOCKED';
        const marker = isEnter ? '▶' : isBlocked ? '✕' : '□';

        // A refused hit is shown in line with the real ones, at the moment it
        // would have counted. Seeing the gap is the whole point.
        const meta = isBlocked
          ? entry.reason === 'refractory'
            ? `locked ${entry.remainingMs?.toFixed(0)}ms`
            : 'low confidence'
          : isEnter
            ? `+${entry.latencyMs.toFixed(0)}ms`
            : `${entry.dwellMs?.toFixed(0)}ms held`;

        const rowClass = isBlocked ? 'log__row--blocked' : isEnter ? '' : 'log__row--exit';

        return (
          <div key={entry.id} className={`log__row ${rowClass}`}>
            <span className="log__time">{(entry.timestampMs / 1000).toFixed(2)}s</span>
            <span style={{ color: isBlocked ? 'var(--bad)' : ZONE_COLOUR[entry.zoneId] }}>
              {marker} {SHORT_ZONE[entry.zoneId] ?? entry.zoneId}{' '}
              {entry.limb === 'leftWrist' ? 'L' : 'R'}
            </span>
            <span className="log__meta">{meta}</span>
          </div>
        );
      })}
    </div>
  );
}
