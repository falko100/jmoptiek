import * as THREE from 'three';
import {
    FaceLandmarker,
    FilesetResolver,
    type FaceLandmarkerResult,
} from '@mediapipe/tasks-vision';
import { FaceLandmark, type FacePose } from './types.ts';

/**
 * Wraps MediaPipe Face Landmarker — detects facial landmarks and
 * outputs 3D transformation matrices for each face.
 */
export class FaceTracker {
    private landmarker: FaceLandmarker | null = null;

    async init(): Promise<void> {
        const vision = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
        );

        this.landmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath:
                    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
                delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numFaces: 4,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: true,
        });
    }

    detect(video: HTMLVideoElement, timestampMs: number): FaceLandmarkerResult {
        if (!this.landmarker) {
            throw new Error('FaceTracker not initialised — call init() first');
        }
        return this.landmarker.detectForVideo(video, timestampMs);
    }

    /**
     * Compute a FacePose for every detected face.
     * Coordinates are in canvas pixel space with mirrored X.
     */
    /**
     * Compute a FacePose for every detected face.
     * Landmarks are mapped through the cover transform so they align with
     * the video as drawn on the canvas.
     *
     * @param drawW  Cover-scaled video width in canvas pixels
     * @param drawH  Cover-scaled video height in canvas pixels
     * @param offsetX  Horizontal offset of the cover-drawn video
     * @param offsetY  Vertical offset of the cover-drawn video
     */
    computePoses(
        result: FaceLandmarkerResult,
        drawW: number,
        drawH: number,
        offsetX: number,
        offsetY: number,
    ): FacePose[] {
        if (!result.faceLandmarks?.length) return [];

        return result.faceLandmarks.map((lm, i) => {
            const leftOuter = lm[FaceLandmark.LEFT_EYE_OUTER];
            const rightOuter = lm[FaceLandmark.RIGHT_EYE_OUTER];
            const noseBridge = lm[FaceLandmark.NOSE_BRIDGE];
            const forehead = lm[FaceLandmark.FOREHEAD];
            const chin = lm[FaceLandmark.CHIN];
            const leftTemple = lm[FaceLandmark.LEFT_TEMPLE];
            const rightTemple = lm[FaceLandmark.RIGHT_TEMPLE];

            // Convert normalised coords → canvas pixels (mirrored X, cover-mapped)
            const lx = (1 - leftOuter.x) * drawW + offsetX;
            const ly = leftOuter.y * drawH + offsetY;
            const rx = (1 - rightOuter.x) * drawW + offsetX;
            const ry = rightOuter.y * drawH + offsetY;

            const dx = rx - lx;
            const dy = ry - ly;
            // 3D eye distance: z is in the same scale as x (normalised to image width),
            // so depth difference in pixels = dz * drawW.
            const dz = (leftOuter.z - rightOuter.z) * drawW;
            const eyeDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const roll = Math.atan2(dy, dx);

            const center = {
                x: (1 - noseBridge.x) * drawW + offsetX,
                y: noseBridge.y * drawH + offsetY,
            };

            // Forehead-to-chin for face height (3D)
            const fhX = (1 - forehead.x) * drawW + offsetX;
            const fhY = forehead.y * drawH + offsetY;
            const chX = (1 - chin.x) * drawW + offsetX;
            const chY = chin.y * drawH + offsetY;
            const fdz = (forehead.z - chin.z) * drawW;
            const faceHeight = Math.sqrt(
                (chX - fhX) ** 2 + (chY - fhY) ** 2 + fdz * fdz,
            );

            const faceCenter = {
                x: (fhX + chX) / 2,
                y: (fhY + chY) / 2,
            };

            // Temple-to-temple face width (3D)
            const ltX = (1 - leftTemple.x) * drawW + offsetX;
            const ltY = leftTemple.y * drawH + offsetY;
            const rtX = (1 - rightTemple.x) * drawW + offsetX;
            const rtY = rightTemple.y * drawH + offsetY;
            const twDx = rtX - ltX;
            const twDy = rtY - ltY;
            const twDz = (leftTemple.z - rightTemple.z) * drawW;
            const faceWidth = Math.sqrt(twDx * twDx + twDy * twDy + twDz * twDz);

            // Grab the 4x4 facial transformation matrix (column-major)
            const matrices = result.facialTransformationMatrixes;
            const matData = matrices?.[i]?.data;
            const matrix = matData
                ? new Float32Array(matData)
                : new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

            // Compute mirrored quaternion from the transformation matrix
            const quaternion = matrixToMirroredQuaternion(matrix);

            const landmarks = {
                leftEye: { x: lx, y: ly },
                rightEye: { x: rx, y: ry },
                forehead: { x: fhX, y: fhY },
                chin: { x: chX, y: chY },
                leftTemple: { x: ltX, y: ltY },
                rightTemple: { x: rtX, y: rtY },
            };

            return { center, faceCenter, eyeDistance, faceHeight, faceWidth, matrix, roll, quaternion, landmarks };
        });
    }

    dispose(): void {
        this.landmarker?.close();
        this.landmarker = null;
    }
}

const _S = new THREE.Matrix4().makeScale(-1, 1, 1);

/** Convert a MediaPipe column-major 4x4 matrix to a mirrored quaternion. */
function matrixToMirroredQuaternion(m: Float32Array): THREE.Quaternion {
    const rot = new THREE.Matrix4();
    rot.set(
        m[0], m[4], m[8],  0,
        m[1], m[5], m[9],  0,
        m[2], m[6], m[10], 0,
        0,    0,    0,     1,
    );
    rot.premultiply(_S).multiply(_S);
    return new THREE.Quaternion().setFromRotationMatrix(rot);
}
