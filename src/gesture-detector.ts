import {
    HandLandmarker,
    FilesetResolver,
} from '@mediapipe/tasks-vision';

export type ButtonSide = 'left' | 'right';
export type ButtonCallback = (side: ButtonSide) => void;

export interface GestureEvent {
    type: 'hand_enter' | 'hand_leave' | 'zone_enter' | 'zone_leave' | 'button_press' | 'cooldown_blocked';
    detail?: string;
}

export interface HandDebugInfo {
    wristX: number;
    wristY: number;
    zone: ButtonSide | null;
}

export interface GestureDebugInfo {
    handsDetected: number;
    hands: HandDebugInfo[];
    /** Fill progress for left button (0–1) */
    leftProgress: number;
    /** Fill progress for right button (0–1) */
    rightProgress: number;
    cooldownRemaining: number;
    events: GestureEvent[];
}

export type DebugCallback = (info: GestureDebugInfo) => void;

const MAX_HANDS = 2;

/**
 * Detects hand-in-zone gestures using MediaPipe Hand Landmarker.
 *
 * Two trigger zones sit in the left and right edges of the frame.
 * When a hand (index finger tip) dwells in a zone long enough,
 * the corresponding button fires.
 */
export class GestureDetector {
    private handLandmarker: HandLandmarker | null = null;
    private callback: ButtonCallback | null = null;
    private debugCallback: DebugCallback | null = null;

    /** How far from the edge (normalised 0–1) the trigger zone extends */
    private static readonly ZONE_WIDTH = 0.15;

    /** Time in ms the hand must stay in the zone to fire */
    private static readonly DWELL_TIME = 600;

    /** Cooldown after a button press before another can fire */
    private static readonly COOLDOWN = 1200;

    /** Accumulated dwell time per zone */
    private dwellAccum: Record<ButtonSide, number> = { left: 0, right: 0 };

    /** Was any hand in this zone last frame? */
    private wasInZone: Record<ButtonSide, boolean> = { left: false, right: false };

    private lastPressTime = 0;
    private prevHandCount = 0;
    private lastTimestamp = 0;

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

    onButton(cb: ButtonCallback): void {
        this.callback = cb;
    }

    onDebug(cb: DebugCallback): void {
        this.debugCallback = cb;
    }

    /**
     * Determine which zone a normalised coordinate falls in.
     * MediaPipe coords are NOT mirrored: x=0 is left-of-camera (right on screen).
     * Since webcam is mirrored: low x = right on screen, high x = left on screen.
     */
    private getZone(x: number): ButtonSide | null {
        if (x <= GestureDetector.ZONE_WIDTH) return 'right';
        if (x >= 1 - GestureDetector.ZONE_WIDTH) return 'left';
        return null;
    }

    detect(video: HTMLVideoElement, timestampMs: number): void {
        if (!this.handLandmarker) return;

        const result = this.handLandmarker.detectForVideo(video, timestampMs);
        const now = timestampMs;
        const dt = this.lastTimestamp > 0 ? now - this.lastTimestamp : 0;
        this.lastTimestamp = now;

        const events: GestureEvent[] = [];
        const handCount = result.landmarks?.length ?? 0;

        // Hand enter/leave
        if (handCount > this.prevHandCount) {
            events.push({ type: 'hand_enter', detail: `${handCount} hand(s)` });
        } else if (handCount < this.prevHandCount) {
            events.push({ type: 'hand_leave', detail: `${handCount} hand(s)` });
        }
        this.prevHandCount = handCount;

        // Track which zones have a hand this frame
        const zonesOccupied: Record<ButtonSide, boolean> = { left: false, right: false };
        const handInfos: HandDebugInfo[] = [];

        for (let h = 0; h < handCount; h++) {
            // Use index finger tip (landmark 8) — more precise than wrist for targeting
            const tip = result.landmarks![h][8];
            const zone = this.getZone(tip.x);

            if (zone) {
                zonesOccupied[zone] = true;
            }

            handInfos.push({
                wristX: tip.x,
                wristY: tip.y,
                zone,
            });
        }

        // Update dwell accumulators for each zone
        for (const side of ['left', 'right'] as ButtonSide[]) {
            if (zonesOccupied[side]) {
                // Zone enter event
                if (!this.wasInZone[side]) {
                    events.push({ type: 'zone_enter', detail: side });
                }

                this.dwellAccum[side] += dt;

                // Check if dwell is complete
                if (this.dwellAccum[side] >= GestureDetector.DWELL_TIME) {
                    if (now - this.lastPressTime > GestureDetector.COOLDOWN) {
                        this.lastPressTime = now;
                        this.dwellAccum[side] = 0;
                        events.push({ type: 'button_press', detail: side });
                        this.callback?.(side);
                    } else {
                        events.push({ type: 'cooldown_blocked', detail: `${side}, ${Math.round(GestureDetector.COOLDOWN - (now - this.lastPressTime))}ms` });
                        // Cap the accumulator so it doesn't overflow
                        this.dwellAccum[side] = GestureDetector.DWELL_TIME;
                    }
                }
            } else {
                // Zone leave event
                if (this.wasInZone[side]) {
                    events.push({ type: 'zone_leave', detail: side });
                }
                // Decay the accumulator quickly when hand leaves
                this.dwellAccum[side] = Math.max(0, this.dwellAccum[side] - dt * 3);
            }

            this.wasInZone[side] = zonesOccupied[side];
        }

        this.emitDebug(handCount, handInfos, now, events);
    }

    private emitDebug(
        handsDetected: number,
        hands: HandDebugInfo[],
        now: number,
        events: GestureEvent[],
    ): void {
        if (!this.debugCallback) return;
        const cooldownRemaining = Math.max(0, GestureDetector.COOLDOWN - (now - this.lastPressTime));
        this.debugCallback({
            handsDetected,
            hands,
            leftProgress: Math.min(this.dwellAccum.left / GestureDetector.DWELL_TIME, 1),
            rightProgress: Math.min(this.dwellAccum.right / GestureDetector.DWELL_TIME, 1),
            cooldownRemaining,
            events,
        });
    }

    dispose(): void {
        this.handLandmarker?.close();
        this.handLandmarker = null;
    }
}
