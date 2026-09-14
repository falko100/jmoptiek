import * as THREE from 'three';
import type { FacePose } from './types.ts';

/**
 * A coarse, geometry-only "is this the same person as a moment ago?" descriptor.
 *
 * It is deliberately NOT face recognition: we never store images, never build a
 * biometric template that survives the visit window, and never send the
 * descriptor to the backend. It exists purely so that one visitor who steps out
 * of frame and back in (or whose tracking drops for a second) is not counted as
 * two different faces.
 *
 * The descriptor is the set of pairwise distances between a handful of stable
 * landmarks, divided by the inter-ocular distance. That makes it invariant to
 * how far away the person stands, where they stand in frame, and how they tilt
 * their head in-plane. It is NOT invariant to yaw/pitch, so signatures are only
 * sampled while the face is roughly frontal.
 */

/**
 * Landmarks used for the descriptor: eye corners, nose, chin, temples,
 * forehead and the outer face edges. Mouth and eyelids are left out — they
 * move with expression and blinking.
 */
const SIGNATURE_LANDMARKS = [33, 133, 362, 263, 1, 6, 152, 234, 454, 10, 127, 356];

/** Eye-corner pair used to normalise scale. */
const LEFT_EYE_OUTER = 263;
const RIGHT_EYE_OUTER = 33;

/** Maximum head yaw/pitch (radians) at which a signature is still sampled. */
const MAX_FRONTAL_ANGLE = 0.26; // ~15°

const _euler = new THREE.Euler();

/** The frontal gate in degrees, for the debug readout. */
export const MAX_FRONTAL_ANGLE_DEG = (MAX_FRONTAL_ANGLE * 180) / Math.PI;

/**
 * Head yaw/pitch in degrees.
 *
 * Worth watching while tuning: the descriptor is a set of projected distances,
 * so turning the head compresses them. At the 15° the gate still allows, the
 * horizontal ones shrink by ~3.4% — on its own already more than a tight match
 * threshold tolerates.
 */
export function headAnglesDeg(pose: FacePose): { yaw: number; pitch: number } {
    _euler.setFromQuaternion(pose.quaternion, 'YXZ');
    return {
        yaw: (_euler.y * 180) / Math.PI,
        pitch: (_euler.x * 180) / Math.PI,
    };
}

/** True when the head is turned far enough for the geometry to be unreliable. */
export function isFrontal(pose: FacePose): boolean {
    _euler.setFromQuaternion(pose.quaternion, 'YXZ');
    return (
        Math.abs(_euler.y) <= MAX_FRONTAL_ANGLE &&
        Math.abs(_euler.x) <= MAX_FRONTAL_ANGLE
    );
}

/**
 * Build a descriptor for a face, or null when the pose is unusable
 * (landmarks missing, head turned away, degenerate scale).
 */
export function computeFaceSignature(pose: FacePose): Float32Array | null {
    const lm = pose.allLandmarks;
    if (!lm || lm.length === 0) return null;
    if (!isFrontal(pose)) return null;

    const left = lm[LEFT_EYE_OUTER];
    const right = lm[RIGHT_EYE_OUTER];
    if (!left || !right) return null;

    const scale = dist3(left, right);
    if (!(scale > 1e-3)) return null;

    const pts = SIGNATURE_LANDMARKS.map((i) => lm[i]);
    if (pts.some((p) => !p)) return null;

    const out = new Float32Array((pts.length * (pts.length - 1)) / 2);
    let k = 0;
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            out[k++] = dist3(pts[i], pts[j]) / scale;
        }
    }
    return out;
}

/** Number of features in a descriptor — handy for tests and sanity checks. */
export const SIGNATURE_LENGTH =
    (SIGNATURE_LANDMARKS.length * (SIGNATURE_LANDMARKS.length - 1)) / 2;

/**
 * Component-wise median of several samples taken during one visit.
 * The median shrugs off the odd frame where the head was half-turned.
 */
export function medianSignature(samples: Float32Array[]): Float32Array | null {
    if (samples.length === 0) return null;
    const len = samples[0].length;
    const out = new Float32Array(len);
    const column = new Float64Array(samples.length);
    for (let i = 0; i < len; i++) {
        for (let s = 0; s < samples.length; s++) column[s] = samples[s][i];
        const sorted = Array.from(column).sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        out[i] =
            sorted.length % 2 === 1
                ? sorted[mid]
                : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return out;
}

/**
 * Mean absolute difference between two descriptors. Roughly "average percent
 * mismatch across the face": ~0.02–0.04 for the same person seen twice,
 * noticeably higher for two different people.
 */
export function signatureDistance(a: Float32Array, b: Float32Array): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Math.abs(a[i] - b[i]);
    return sum / len;
}

function dist3(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
