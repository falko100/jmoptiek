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
    computePoses(
        result: FaceLandmarkerResult,
        canvasWidth: number,
        canvasHeight: number,
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

            // Convert normalised coords → canvas pixels (mirrored X)
            const lx = (1 - leftOuter.x) * canvasWidth;
            const ly = leftOuter.y * canvasHeight;
            const rx = (1 - rightOuter.x) * canvasWidth;
            const ry = rightOuter.y * canvasHeight;

            const dx = rx - lx;
            const dy = ry - ly;
            // 3D eye distance: z is in the same scale as x (normalised to image width),
            // so depth difference in pixels = dz * canvasWidth.
            // This stays constant regardless of head rotation (foreshortening in x
            // is compensated by depth separation in z).
            const dz = (leftOuter.z - rightOuter.z) * canvasWidth;
            const eyeDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const roll = Math.atan2(dy, dx);

            const center = {
                x: (1 - noseBridge.x) * canvasWidth,
                y: noseBridge.y * canvasHeight,
            };

            // Forehead-to-chin for face height (3D)
            const fhX = (1 - forehead.x) * canvasWidth;
            const fhY = forehead.y * canvasHeight;
            const chX = (1 - chin.x) * canvasWidth;
            const chY = chin.y * canvasHeight;
            const fdz = (forehead.z - chin.z) * canvasWidth;
            const faceHeight = Math.sqrt(
                (chX - fhX) ** 2 + (chY - fhY) ** 2 + fdz * fdz,
            );

            const faceCenter = {
                x: (fhX + chX) / 2,
                y: (fhY + chY) / 2,
            };

            // Temple-to-temple face width (3D)
            const ltX = (1 - leftTemple.x) * canvasWidth;
            const ltY = leftTemple.y * canvasHeight;
            const rtX = (1 - rightTemple.x) * canvasWidth;
            const rtY = rightTemple.y * canvasHeight;
            const twDx = rtX - ltX;
            const twDy = rtY - ltY;
            const twDz = (leftTemple.z - rightTemple.z) * canvasWidth;
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
