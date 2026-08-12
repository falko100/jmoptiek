import {
    HandLandmarker,
    FilesetResolver,
} from '@mediapipe/tasks-vision';

/** Recognised finger gestures and the action each maps to. */
export type GestureAction = 'prev' | 'next' | 'type';

export interface HandDebugInfo {
    /** All 21 hand landmarks in canvas pixel space (mirrored X) */
    landmarks: { x: number; y: number; z: number }[];
}

export interface GestureEvent {
    type: 'hand_enter' | 'hand_leave' | 'gesture_trigger';
    detail?: string;
}

export interface GestureDebugInfo {
    handsDetected: number;
    hands: HandDebugInfo[];
    /** Human-readable label for the gesture currently held (or '—') */
    currentGesture: string;
    /** ms until another gesture may fire */
    cooldownRemaining: number;
    events: GestureEvent[];
}

export type TriggerCallback = (action: GestureAction) => void;
export type DebugCallback = (info: GestureDebugInfo) => void;

const MAX_HANDS = 4;

/** Short label per gesture for the debug panel. */
const GESTURE_LABEL: Record<GestureAction, string> = {
    next: '☝️ 1 finger · volgende',
    prev: '✌️ 2 fingers · vorige',
    type: '🤟 3 fingers · bril/zon',
};

/**
 * Recognises static finger gestures from a single hand and maps them to
 * navigation actions. Each gesture must be held briefly (STABLE_MS) before it
 * fires, so the transient finger counts seen while a hand opens/closes don't
 * trigger anything. A gesture fires once; to repeat it, relax the hand (or
 * form a different shape) and make it again.
 */
export class GestureDetector {
    private handLandmarker: HandLandmarker | null = null;
    private triggerCallback: TriggerCallback | null = null;
    private debugCallback: DebugCallback | null = null;

    /** How long a gesture must be held before it fires */
    private static readonly STABLE_MS = 280;
    /** Minimum gap between two fired gestures */
    private static readonly COOLDOWN = 800;

    /** Cover transform — maps normalised landmarks to canvas pixels */
    private drawW = 1;
    private drawH = 1;
    private offsetX = 0;
    private offsetY = 0;

    private prevHandCount = 0;

    // Gesture debounce state
    private candidate: GestureAction | null = null;
    private candidateSince = 0;
    private lastFired: GestureAction | null = null;
    private lastFireTime = -Infinity;

    async init(): Promise<void> {
        const vision = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
        );

        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath:
                    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
                delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numHands: MAX_HANDS,
        });
    }

    onTrigger(cb: TriggerCallback): void {
        this.triggerCallback = cb;
    }

    onDebug(cb: DebugCallback): void {
        this.debugCallback = cb;
    }

    setVisibleBounds(drawW: number, drawH: number, offsetX: number, offsetY: number): void {
        this.drawW = drawW;
        this.drawH = drawH;
        this.offsetX = offsetX;
        this.offsetY = offsetY;
    }

    detect(video: HTMLVideoElement, timestampMs: number): void {
        if (!this.handLandmarker) return;

        const result = this.handLandmarker.detectForVideo(video, timestampMs);
        const now = timestampMs;

        const events: GestureEvent[] = [];
        const handCount = result.landmarks?.length ?? 0;

        // Visible 1:1 window — ignore hands in the cropped side regions.
        const visibleW = this.drawW + 2 * this.offsetX;
        const visibleH = this.drawH + 2 * this.offsetY;

        const handsCanvas: { x: number; y: number; z: number }[][] = [];
        const handInfos: HandDebugInfo[] = [];
        for (let h = 0; h < handCount; h++) {
            const lm = result.landmarks![h];
            const canvasLm = lm.map((pt) => ({
                x: (1 - pt.x) * this.drawW + this.offsetX,
                y: pt.y * this.drawH + this.offsetY,
                z: pt.z,
            }));
            const wrist = canvasLm[0];
            if (wrist.x < 0 || wrist.x > visibleW || wrist.y < 0 || wrist.y > visibleH) {
                continue; // off-screen (cropped side region)
            }
            handsCanvas.push(canvasLm);
            handInfos.push({ landmarks: canvasLm });
        }

        const visibleCount = handsCanvas.length;
        if (visibleCount > this.prevHandCount) {
            events.push({ type: 'hand_enter', detail: `${visibleCount} hand(s)` });
        } else if (visibleCount < this.prevHandCount) {
            events.push({ type: 'hand_leave', detail: `${visibleCount} hand(s)` });
        }
        this.prevHandCount = visibleCount;

        // Classify the first visible hand.
        const gesture = visibleCount > 0
            ? GestureDetector.classify(handsCanvas[0])
            : null;

        // Debounce: require the same gesture to be held for STABLE_MS, fire
        // once, and only re-fire after the hand relaxes to a different shape.
        if (gesture !== this.candidate) {
            this.candidate = gesture;
            this.candidateSince = now;
        }
        // Relaxing the hand (no gesture) re-arms firing, so the same gesture can
        // be repeated by forming it again.
        if (gesture === null) this.lastFired = null;

        const held = gesture !== null && now - this.candidateSince >= GestureDetector.STABLE_MS;
        const cooled = now - this.lastFireTime >= GestureDetector.COOLDOWN;
        if (held && gesture !== this.lastFired && cooled) {
            this.lastFired = gesture;
            this.lastFireTime = now;
            events.push({ type: 'gesture_trigger', detail: GESTURE_LABEL[gesture!] });
            this.triggerCallback?.(gesture!);
        }

        if (this.debugCallback) {
            this.debugCallback({
                handsDetected: visibleCount,
                hands: handInfos,
                currentGesture: gesture ? GESTURE_LABEL[gesture] : '—',
                cooldownRemaining: Math.max(0, GestureDetector.COOLDOWN - (now - this.lastFireTime)),
                events,
            });
        }
    }

    /**
     * Classifies a hand into a gesture from its extended-finger pattern.
     * Anchored on the index finger so the counts are unambiguous:
     *   index only            → next
     *   index+middle (peace)  → prev
     *   index+middle+ring     → type (glasses/sunglasses)
     * The thumb is ignored (its extension is unreliable to detect).
     */
    private static classify(hand: { x: number; y: number; z: number }[]): GestureAction | null {
        const [idx, mid, ring, pinky] = GestureDetector.fingersExtended(hand);
        const key = `${+idx}${+mid}${+ring}${+pinky}`;
        switch (key) {
            case '1000': return 'next';
            case '1100': return 'prev';
            case '1110': return 'type';
            default: return null;
        }
    }

    /**
     * Extended state of [index, middle, ring, pinky]. A finger is extended when
     * its tip is farther from the wrist than its PIP joint — orientation- and
     * scale-independent, so it works at any hand angle or distance.
     */
    private static fingersExtended(
        hand: { x: number; y: number; z: number }[],
    ): [boolean, boolean, boolean, boolean] {
        const wrist = hand[0];
        const d = (i: number) => Math.hypot(hand[i].x - wrist.x, hand[i].y - wrist.y);
        const ext = (tip: number, pip: number) => d(tip) > d(pip) * 1.1;
        return [ext(8, 6), ext(12, 10), ext(16, 14), ext(20, 18)];
    }

    dispose(): void {
        this.handLandmarker?.close();
        this.handLandmarker = null;
    }
}
