/**
 * The boundary between MediaPipe and the rest of hop//beat.
 *
 * Nothing downstream of this file imports @mediapipe/tasks-vision. The engine
 * consumes PoseSnapshot, so a different pose backend (or a recorded fixture in
 * a unit test) can be substituted without touching gameplay code. Spec §21.
 */

/**
 * BlazePose's 33-landmark topology, named. MediaPipe returns a flat array and
 * you are expected to know that index 15 is the left wrist; naming it once here
 * means no magic numbers survive past this module.
 *
 * "left" and "right" are ANATOMICAL — the player's own left and right. In an
 * unmirrored camera image the player's left wrist appears on the right-hand
 * side of the picture. See transforms.ts, which is where that stops being
 * confusing.
 */
export const POSE_LANDMARKS = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

export type LandmarkName = keyof typeof POSE_LANDMARKS;

export const LANDMARK_NAMES = Object.keys(POSE_LANDMARKS) as LandmarkName[];

/** Bone connections, for drawing a readable skeleton rather than a dot cloud. */
export const POSE_BONES: ReadonlyArray<readonly [LandmarkName, LandmarkName]> = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
];

/**
 * A point in FIELD SPACE: the 0–1 play area described in spec §6, with (0,0) at
 * the top-left of the screen as the player sees it. Mirroring has already been
 * applied. Gameplay only ever reasons in this space.
 */
export interface FieldPoint {
  x: number;
  y: number;
  /** MediaPipe's own confidence that this landmark is really visible, 0–1. */
  visibility: number;
}

/**
 * One frame of body data. `timestampMs` is when the CAMERA FRAME existed, not
 * when we finished processing it — that distinction is the whole reason MVP 1
 * can judge timing honestly. Spec §7.
 */
export interface PoseSnapshot {
  timestampMs: number;
  landmarks: Record<LandmarkName, FieldPoint>;
}

/** The limbs MVP 0 accepts as input. Spec §6: wrists/hands only. */
export const INPUT_LIMBS = ['leftWrist', 'rightWrist'] as const;
export type InputLimb = (typeof INPUT_LIMBS)[number];
