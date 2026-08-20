/**
 * Webcam acquisition. Deliberately separate from pose inference so a camera
 * failure reads as a camera failure, not a mysterious model error.
 */

export interface CameraInfo {
  stream: MediaStream;
  width: number;
  height: number;
  /** What the camera actually agreed to, which is rarely what we asked for. */
  frameRate: number;
  label: string;
}

export class CameraError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'CameraError';
    this.hint = hint;
  }
}

/**
 * `getUserMedia` constraints are requests, not commands. We ask for 1280x720 at
 * 60 fps because pose latency is bounded below by how often the camera produces
 * frames — but most laptop webcams will quietly hand back 720p30 or 1080p30,
 * so we report what we actually got rather than assuming.
 */
export async function startCamera(deviceId?: string): Promise<CameraInfo> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(
      'This browser has no camera API.',
      'getUserMedia needs a secure context — use https, or localhost in development.',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
        facingMode: 'user',
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  } catch (err) {
    throw asCameraError(err);
  }

  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  return {
    stream,
    width: settings.width ?? 640,
    height: settings.height ?? 480,
    frameRate: settings.frameRate ?? 30,
    label: track.label || 'camera',
  };
}

export function stopCamera(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Enumerable cameras. Labels are empty until permission has been granted once. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

function asCameraError(err: unknown): CameraError {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return new CameraError(
        'Camera permission was denied.',
        'Allow camera access for this site, then reload.',
      );
    case 'NotFoundError':
      return new CameraError(
        'No camera found.',
        'Connect a webcam and reload.',
      );
    case 'NotReadableError':
      return new CameraError(
        'The camera is in use by another application.',
        'Close anything else using the webcam — video calls are the usual culprit.',
      );
    case 'OverconstrainedError':
      return new CameraError(
        'The camera cannot satisfy the requested video format.',
        'Try a different camera from the device list.',
      );
    default:
      return new CameraError(
        err instanceof Error ? err.message : 'Unknown camera error.',
        'Check the browser console for details.',
      );
  }
}
