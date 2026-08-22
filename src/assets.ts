/**
 * Where the runtime assets live.
 *
 * Every path here must go through `import.meta.env.BASE_URL`. GitHub Pages
 * serves a project site from a subdirectory — `/hop-beat/` rather than `/` —
 * so an absolute path like `/models/x.task` resolves to the wrong host root and
 * 404s. It works perfectly in development, which is exactly what makes it easy
 * to ship broken.
 */

/** Base path, always with a trailing slash. */
const base = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

export function assetUrl(path: string): string {
  return `${base}${path.replace(/^\//, '')}`;
}

export const MEDIAPIPE_WASM_PATH = assetUrl('mediapipe/wasm');

export function poseModelUrl(variant: string): string {
  return assetUrl(`models/pose_landmarker_${variant}.task`);
}

export const GESTURE_MODEL_URL = assetUrl('models/gesture_recognizer.task');

/**
 * Audio is gitignored, so a deployed build has none of it.
 *
 * Charts that need a file the deployment does not carry must be discoverable
 * before they are offered, not after the player has picked one and hit play.
 */
export async function audioExists(src: string): Promise<boolean> {
  try {
    const response = await fetch(assetUrl(src), { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}
