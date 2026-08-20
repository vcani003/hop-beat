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
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
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
          label="min visibility"
          value={settings.minVisibility}
          min={0}
          max={0.95}
          step={0.05}
          display={settings.minVisibility.toFixed(2)}
          onChange={(v) => set('minVisibility', v)}
        />
        <Slider
          label="exit radius (hysteresis)"
          value={settings.exitRadiusScale}
          min={1}
          max={2}
          step={0.05}
          display={`${settings.exitRadiusScale.toFixed(2)}×`}
          onChange={(v) => set('exitRadiusScale', v)}
        />
        <Slider
          label="exit grace"
          value={settings.exitGraceMs}
          min={0}
          max={300}
          step={10}
          display={`${settings.exitGraceMs} ms`}
          onChange={(v) => set('exitGraceMs', v)}
        />
        <Slider
          label="refractory"
          value={settings.refractoryMs}
          min={0}
          max={500}
          step={10}
          display={`${settings.refractoryMs} ms`}
          onChange={(v) => set('refractoryMs', v)}
        />
        <Toggle
          label="reject landmarks outside frame"
          checked={settings.requireInFrame}
          onChange={(v) => set('requireInFrame', v)}
        />
        <p className="hint">
          Set hysteresis to 1.00× and grace to 0 ms to see the raw chatter these two
          settings exist to suppress.
        </p>
      </div>

      <div className="panel__section">
        <h2 className="panel__heading">View</h2>
        <Toggle label="mirror (natural movement)" checked={settings.mirrored} onChange={(v) => set('mirrored', v)} />
        <Toggle label="show camera" checked={settings.showVideo} onChange={(v) => set('showVideo', v)} />
        <Toggle label="show skeleton" checked={settings.showSkeleton} onChange={(v) => set('showSkeleton', v)} />
        <p className="hint">
          Turn the camera off to check spec open question #10 — whether an abstract
          figure is enough to play by.
        </p>
      </div>
    </>
  );
}
