/**
 * The session readout: where the hits went, and — more usefully — which hits
 * the tracker refused.
 *
 * The repeat-interval row is the one to watch. It converts measured hit gaps
 * into the fastest tempo the current settings could actually follow, which
 * turns "rapid hits sometimes don't register" from a feeling into a number.
 */
import { maxSustainableBpm, type SessionSummary } from '../debug/SessionRecorder.ts';
import { ZONE_IDS } from '../game/zones.ts';

const ZONE_COLOUR: Record<string, string> = {
  upperLeft: 'var(--violet)',
  upperRight: 'var(--cyan)',
  lowerLeft: 'var(--gold)',
  lowerRight: 'var(--pink)',
};

const SHORT: Record<string, string> = {
  upperLeft: 'UL',
  upperRight: 'UR',
  lowerLeft: 'LL',
  lowerRight: 'LR',
};

interface Props {
  summary: SessionSummary;
  refractoryMs: number;
  onExport: () => void;
  onClear: () => void;
}

export default function SessionPanel({ summary, refractoryMs, onExport, onClear }: Props) {
  const { repeatInterval: repeat, fastestBlockedRepeatMs: blockedRepeat } = summary;

  // The settings are the ceiling when a refused repeat was faster than any the
  // tracker accepted: the player was already going quicker than it allows.
  const settingsAreTheLimit =
    blockedRepeat !== null && (repeat.fastestMs === null || blockedRepeat < repeat.fastestMs);

  return (
    <div className="panel__section">
      <h2 className="panel__heading">Session</h2>

      <div className="zonegrid">
        {ZONE_IDS.map((id) => {
          const zone = summary.perZone[id];
          return (
            <div key={id} className="zonegrid__cell">
              <span className="zonegrid__label mono" style={{ color: ZONE_COLOUR[id] }}>
                {SHORT[id]}
              </span>
              <span className="zonegrid__hits mono">{zone.hits}</span>
              {zone.blocked > 0 && (
                <span className="zonegrid__blocked mono">{zone.blocked} refused</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="row">
        <span className="row__label">hits</span>
        <span className="row__value mono">{summary.hits}</span>
      </div>
      <div className="row">
        <span className="row__label">mean dwell</span>
        <span className="row__value mono">{summary.meanDwellMs.toFixed(0)} ms</span>
      </div>
      <div className="row">
        <span className="row__label">fastest repeat</span>
        <span className="row__value mono">
          {repeat.fastestMs === null ? '—' : `${repeat.fastestMs.toFixed(0)} ms`}
        </span>
      </div>
      <div className="row">
        <span className="row__label">refused (lockout)</span>
        <span
          className="row__value mono"
          style={{ color: summary.blocked.refractory > 0 ? 'var(--gold)' : undefined }}
        >
          {summary.blocked.refractory}
        </span>
      </div>
      <div className="row">
        <span className="row__label">refused (confidence)</span>
        <span
          className="row__value mono"
          style={{ color: summary.blocked.visibility > 0 ? 'var(--gold)' : undefined }}
        >
          {summary.blocked.visibility}
        </span>
      </div>

      {repeat.fastestMs !== null && (
        <p className="hint" style={{ marginTop: 8 }}>
          Fastest accepted repeat on one target: {repeat.fastestMs.toFixed(0)} ms — quarter
          notes up to about {maxSustainableBpm(repeat.fastestMs).toFixed(0)} BPM.
        </p>
      )}

      {settingsAreTheLimit && (
        <p className="hint" style={{ marginTop: 8, color: 'var(--gold)' }}>
          You hit one target again after {blockedRepeat!.toFixed(0)} ms and it was refused:
          the {refractoryMs} ms lockout is the ceiling, not your movement. Lower{' '}
          <strong>refractory</strong> to roughly{' '}
          {Math.max(0, Math.round((blockedRepeat! - 40) / 10) * 10)} ms and raise{' '}
          <strong>exit radius</strong> above 1.00× to keep chatter suppressed.
        </p>
      )}

      <div className="buttonrow">
        <button onClick={onExport} disabled={summary.hits === 0 && summary.exits === 0}>
          Download log
        </button>
        <button onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}
