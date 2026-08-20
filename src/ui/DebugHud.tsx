/**
 * The numbers that decide whether MVP 0 passed. Spec §18 asks for a developer
 * HUD; this is it, minus the song-related rows that do not exist yet.
 */
import type { Settings, TelemetryView } from './types.ts';

interface Props {
  telemetry: TelemetryView;
  settings: Settings;
  live: boolean;
}

/**
 * Colour thresholds are judgement calls, stated openly rather than hidden:
 * a rhythm game's PERFECT window is ~80 ms (spec §7), so input latency in the
 * same order of magnitude is already eating the whole window.
 */
function verdict(value: number, good: number, poor: number): string {
  if (value <= good) return 'var(--good)';
  if (value <= poor) return 'var(--gold)';
  return 'var(--bad)';
}

function Row({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className="row__value mono" style={colour ? { color: colour } : undefined}>
        {value}
      </span>
    </div>
  );
}

export default function DebugHud({ telemetry, settings, live }: Props) {
  if (!live) {
    return (
      <div className="panel__section">
        <h2 className="panel__heading">Telemetry</h2>
        <p className="hint">Start the camera to measure inference cost and input latency.</p>
      </div>
    );
  }

  const t = telemetry;

  return (
    <>
      <div className="panel__section">
        <h2 className="panel__heading">Timing</h2>
        <Row label="pose rate" value={`${t.poseHz.toFixed(1)} Hz`} colour={verdict(-t.poseHz, -24, -15)} />
        <Row label="render" value={`${t.renderFps.toFixed(0)} fps`} colour={verdict(-t.renderFps, -55, -30)} />
        <Row
          label="inference mean"
          value={`${t.inferenceMeanMs.toFixed(1)} ms`}
          colour={verdict(t.inferenceMeanMs, 15, 33)}
        />
        <Row
          label="inference p95"
          value={`${t.inferenceP95Ms.toFixed(1)} ms`}
          colour={verdict(t.inferenceP95Ms, 25, 50)}
        />
        <Row
          label="input latency"
          value={`${t.latencyMeanMs.toFixed(1)} ms`}
          colour={verdict(t.latencyMeanMs, 40, 80)}
        />
        <Row
          label="latency p95"
          value={`${t.latencyP95Ms.toFixed(1)} ms`}
          colour={verdict(t.latencyP95Ms, 60, 120)}
        />
        {t.suspectRatio > 0.1 && (
          <p className="hint" style={{ marginTop: 8, color: 'var(--gold)' }}>
            {(t.suspectRatio * 100).toFixed(0)}% of frames carry an implausible
            timestamp — the latency figures above are not measuring your camera.
          </p>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Input latency is camera-frame time to event, measured end to end. It is the
          budget MVP 1's ±80 ms PERFECT window has to fit inside.
        </p>
      </div>

      <div className="panel__section">
        <h2 className="panel__heading">Pipeline</h2>
        <Row label="camera" value={`${t.cameraWidth}×${t.cameraHeight} @ ${t.cameraFps.toFixed(0)}`} />
        <Row label="device" value={t.cameraLabel.slice(0, 22) || '—'} />
        <Row label="model" value={`${settings.modelVariant} · ${settings.delegate}`} />
        <Row
          label="frame source"
          value={t.usesFrameCallback ? 'per camera frame' : 'rAF fallback'}
          colour={t.usesFrameCallback ? 'var(--good)' : 'var(--gold)'}
        />
        <Row
          label="frame clock"
          value={t.frameClockSource}
          colour={t.frameClockSource === 'captureTime' ? 'var(--good)' : 'var(--gold)'}
        />
        <Row label="person" value={t.detected ? 'detected' : 'none'} colour={t.detected ? 'var(--good)' : 'var(--bad)'} />
        {t.frameClockSource !== 'captureTime' && (
          <p className="hint" style={{ marginTop: 8 }}>
            This platform does not expose <code>captureTime</code>, so frame times come
            from <code>{t.frameClockSource}</code>. Latency therefore includes the
            browser's compositor, not just capture and inference.
          </p>
        )}
      </div>
    </>
  );
}
