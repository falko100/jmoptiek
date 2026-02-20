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

            // Convert normalised coords → canvas pixels (mirrored X)
            const lx = (1 - leftOuter.x) * canvasWidth;
            const ly = leftOuter.y * canvasHeight;
            const rx = (1 - rightOuter.x) * canvasWidth;
            const ry = rightOuter.y * canvasHeight;

            const dx = rx - lx;
            const dy = ry - ly;
            const eyeDistance = Math.hypot(dx, dy);
            const roll = Math.atan2(dy, dx);

            const center = {
                x: (1 - noseBridge.x) * canvasWidth,
                y: noseBridge.y * canvasHeight,
            };

            // Forehead-to-chin for face height
            const fhX = (1 - forehead.x) * canvasWidth;
            const fhY = forehead.y * canvasHeight;
            const chX = (1 - chin.x) * canvasWidth;
            const chY = chin.y * canvasHeight;
            const faceHeight = Math.hypot(chX - fhX, chY - fhY);

            const faceCenter = {
                x: (fhX + chX) / 2,
                y: (fhY + chY) / 2,
            };

            // Grab the 4x4 facial transformation matrix (column-major)
            const matrices = result.facialTransformationMatrixes;
            const matData = matrices?.[i]?.data;
            const matrix = matData
                ? new Float32Array(matData)
                : new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

            return { center, faceCenter, eyeDistance, faceHeight, matrix, roll };
        });
    }

    dispose(): void {
        this.landmarker?.close();
        this.landmarker = null;
    }
}
