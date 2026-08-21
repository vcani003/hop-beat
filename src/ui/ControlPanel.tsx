/**
 * Every tuning knob MVP 0 needs, changeable while standing in front of the
 * camera. Spec §20 lists "how large should screen zones be" and "what pose
 * inference rate gives the best tradeoff" as open questions to learn through
 * prototyping — which only works if the answers can be dialled in live.
 */
import type { Delegate, ModelVariant } from '../pose/MediaPipePoseProvider.ts';
import type { Settings } from './types.ts';

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  disabled: boolean;
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  help,
  warning,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  /** What this control actually does, in plain language. */
  help?: React.ReactNode;
  /** Shown when the current value is a known trap. */
  warning?: React.ReactNode;
  onChange: (value: number) => void;
}) {
  return (
    <div className="field">
      <label className="field__label">
        <span>{label}</span>
        <span className="field__value mono">{display}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help && <p className="field__help">{help}</p>}
      {warning && <p className="field__help field__help--warn">{warning}</p>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function ControlPanel({ settings, onChange, disabled }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <>
      <div className="panel__section">
        <h2 className="panel__heading">Model</h2>
        <div className="field">
          <label className="field__label"><span>variant</span></label>
          <select
            value={settings.modelVariant}
            disabled={disabled}
            onChange={(e) => set('modelVariant', e.target.value as ModelVariant)}
          >
            <option value="lite">lite — 5.8 MB, fastest</option>
            <option value="full">full — 9.4 MB, more accurate</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label"><span>delegate</span></label>
          <select
            value={settings.delegate}
            disabled={disabled}
            onChange={(e) => set('delegate', e.target.value as Delegate)}
          >
            <option value="GPU">GPU — WebGL shaders</option>
            <option value="CPU">CPU — SIMD WebAssembly</option>
          </select>
        </div>
        <p className="hint">
          Swapping either rebuilds the model but keeps the camera running, so both can
          be measured on the same body in the same light.
        </p>
      </div>

      <div className="panel__section">
        <h2 className="panel__heading">Zones</h2>
        <Slider
          label="size"
          value={settings.zoneScale}
          min={0.5}
          max={2}
          step={0.05}
          display={`${settings.zoneScale.toFixed(2)}×`}
          help="How big the four targets are. Smaller asks for more precision; larger forgives sloppier aim."
          onChange={(v) => set('zoneScale', v)}
        />
        <p className="hint">
          Spec open question #3: how large is intentional rather than frustrating? Find
          the answer by moving, not by guessing.
        </p>
      </div>

      <div className="panel__section">
        <h2 className="panel__heading">Detection</h2>
        <Slider
          label="confidence needed"
          value={settings.minVisibility}
          min={0}
          max={0.95}
          step={0.05}
          display={settings.minVisibility.toFixed(2)}
          help="How certain the model must be that it is really seeing your wrist before a hit counts. Raise it if phantom hits appear; lower it if real hits are ignored in dim light."
          onChange={(v) => set('minVisibility', v)}
        />
        <Slider
          label="exit radius — hysteresis"
          value={settings.exitRadiusScale}
          min={1}
          max={2}
          step={0.05}
          display={`${settings.exitRadiusScale.toFixed(2)}×`}
          help={
            <>
              Each zone has two rings: an inner one you cross to <strong>enter</strong>,
              and an outer one you must cross to <strong>leave</strong>. This sets how
              much bigger the outer ring is. Judges by <strong>distance</strong>, so it
              can tell a small wobble from a real second hit.
            </>
          }
          warning={
            settings.exitRadiusScale <= 1.02 ? (
              <>
                At 1.00× the two rings are the same ring — there is no gap, so a hand
                resting near the edge will flicker in and out. Try 1.25×.
              </>
            ) : undefined
          }
          onChange={(v) => set('exitRadiusScale', v)}
        />
        <Slider
          label="exit grace"
          value={settings.exitGraceMs}
          min={0}
          max={300}
          step={10}
          display={`${settings.exitGraceMs} ms`}
          help="How long you must stay outside before leaving counts. Covers the model losing sight of your hand for a frame or two mid-motion."
          onChange={(v) => set('exitGraceMs', v)}
        />
        <Slider
          label="re-entry lockout — refractory"
          value={settings.refractoryMs}
          min={0}
          max={500}
          step={10}
          display={`${settings.refractoryMs} ms`}
          help={
            <>
              After you leave a zone, how long it ignores you completely. Judges by{' '}
              <strong>time</strong> — which means it cannot tell a wobble from a
              deliberate fast repeat, and blocks both.
            </>
          }
          warning={
            settings.refractoryMs >= 200 ? (
              <>
                {settings.refractoryMs} ms blocks any repeat hit faster than{' '}
                {(60000 / settings.refractoryMs).toFixed(0)} BPM. Use hysteresis for
                chatter instead, and keep this near 0.
              </>
            ) : undefined
          }
          onChange={(v) => set('refractoryMs', v)}
        />
        <Toggle
          label="reject landmarks outside frame"
          checked={settings.requireInFrame}
          onChange={(v) => set('requireInFrame', v)}
        />
        <p className="hint">
          Refused hits show in red in the event log, at the moment they would have
          counted — so a setting that is eating your hits says so.
        </p>
      </div>

      <div className="panel__section">
        <h2 className="panel__heading">View</h2>
        <Toggle label="mirror (natural movement)" checked={settings.mirrored} onChange={(v) => set('mirrored', v)} />
        <Toggle label="show camera" checked={settings.showVideo} onChange={(v) => set('showVideo', v)} />
        <Toggle label="show skeleton" checked={settings.showSkeleton} onChange={(v) => set('showSkeleton', v)} />
        <p className="hint">
          Turn the camera off to check spec open question #9 — whether an abstract
          figure is enough to play by.
        </p>
      </div>
    </>
  );
}
