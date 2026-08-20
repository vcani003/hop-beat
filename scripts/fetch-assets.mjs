/**
 * Vendors the MediaPipe runtime into public/ so the app never depends on a CDN
 * at play time. Both outputs are gitignored: they are ~50 MB of derived assets,
 * reproducible from this script.
 *
 *   public/mediapipe/wasm/   copied from node_modules (the inference runtime)
 *   public/models/*.task     downloaded from Google's official model host
 *
 * Runs automatically on `npm install` via the postinstall hook.
 */
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDest = resolve(root, 'public/mediapipe/wasm');
const modelDir = resolve(root, 'public/models');

/**
 * Pose Landmarker model variants. All three share the same 33-landmark output,
 * so they are interchangeable at runtime — they trade accuracy against
 * inference cost. Keeping two on disk lets us answer spec open question #2
 * ("what pose inference rate gives the best CPU/latency tradeoff?") by
 * measuring on real hardware instead of guessing.
 */
const MODELS = ['lite', 'full'];
const modelUrl = (v) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task`;

const exists = (p) => stat(p).then(() => true, () => false);

async function copyWasm() {
  if (!(await exists(wasmSrc))) {
    throw new Error(`MediaPipe wasm not found at ${wasmSrc}. Run npm install first.`);
  }
  await cp(wasmSrc, wasmDest, { recursive: true });
  console.log('  wasm     vendored from node_modules');
}

async function fetchModel(variant) {
  const dest = resolve(modelDir, `pose_landmarker_${variant}.task`);
  if (await exists(dest)) {
    console.log(`  ${variant.padEnd(8)} already present`);
    return;
  }
  const res = await fetch(modelUrl(variant));
  if (!res.ok) throw new Error(`${variant}: HTTP ${res.status} from ${modelUrl(variant)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(dest, bytes);
  console.log(`  ${variant.padEnd(8)} downloaded (${(bytes.length / 1e6).toFixed(1)} MB)`);
}

await mkdir(modelDir, { recursive: true });
console.log('hop//beat: vendoring pose assets');
await copyWasm();
for (const v of MODELS) await fetchModel(v);
console.log('done.');
