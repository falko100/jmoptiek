/** 2D point in canvas pixel coordinates */
export interface Point {
    x: number;
    y: number;
}

/** Full 3D pose for placing a glasses model on a face */
export interface FacePose {
    /** Nose bridge position in canvas pixels (mirrored X) */
    center: Point;
    /** Centre of the face bounding box (forehead–chin midpoint) in canvas pixels */
    faceCenter: Point;
    /** Eye-to-eye distance in canvas pixels — used as scale reference */
    eyeDistance: number;
    /** Forehead-to-chin distance in canvas pixels */
    faceHeight: number;
    /** 4x4 column-major facial transformation matrix from MediaPipe */
    matrix: Float32Array;
    /** In-plane rotation angle in radians (tilt between eyes) */
    roll: number;
}

/**
 * Subset of MediaPipe face landmark indices we care about.
 * Full map: https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
 */
export const FaceLandmark = {
    /** Left eye outer corner */
    LEFT_EYE_OUTER: 263,
    /** Left eye inner corner */
    LEFT_EYE_INNER: 362,
    /** Right eye inner corner */
    RIGHT_EYE_INNER: 133,
    /** Right eye outer corner */
    RIGHT_EYE_OUTER: 33,
    /** Nose bridge top (between eyes) */
    NOSE_BRIDGE: 6,
    /** Forehead centre */
    FOREHEAD: 10,
    /** Chin bottom */
    CHIN: 152,
} as const;
