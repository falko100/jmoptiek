import {
    HandLandmarker,
    FilesetResolver,
} from '@mediapipe/tasks-vision';

export interface ButtonConfig {
    id: string;
    /** Rect in canvas pixel coordinates (mirrored X — same space as hand landmarks output) */
    rect: { x: number; y: number; w: number; h: number };
}

export interface ButtonState {
    id: string;
    /** Dwell progress 0–1 */
    progress: number;
    occupied: boolean;
}

export interface HandDebugInfo {
    /** All 21 hand landmarks in canvas pixel space (mirrored X) */
    landmarks: { x: number; y: number; z: number }[];
}

export interface GestureEvent {
    type:
        | 'hand_enter'
        | 'hand_leave'
        | 'button_enter'
        | 'button_leave'
        | 'button_trigger'
        | 'cooldown_blocked';
    detail?: string;
}

export interface GestureDebugInfo {
    handsDetected: number;
    hands: HandDebugInfo[];
    buttons: ButtonState[];
    cooldownRemaining: number;
    events: GestureEvent[];
}

export type ButtonTriggerCallback = (buttonId: string) => void;
export type DebugCallback = (info: GestureDebugInfo) => void;

const MAX_HANDS = 4;

/**
 * Detects when a hand "touches" any of the registered button rects.
 * Buttons are defined in canvas pixel space. Any hand landmark inside
 * a button rect counts as a touch; once dwelled long enough, the button fires.
 */
export class GestureDetector {
    private handLandmarker: HandLandmarker | null = null;
    private triggerCallback: ButtonTriggerCallback | null = null;
    private debugCallback: DebugCallback | null = null;

    /** Time in ms the hand must stay on a button to fire */
    private static readonly DWELL_TIME = 600;

    /** Cooldown after any button fires before another can fire */
    private static readonly COOLDOWN = 1000;

    /** Cover transform — used to map normalised landmarks to canvas pixels */
    private drawW = 1;
    private drawH = 1;
    private offsetX = 0;
    private offsetY = 0;

    private buttons: ButtonConfig[] = [];
    private dwellAccum = new Map<string, number>();
    private wasOccupied = new Map<string, boolean>();

    private lastTriggerTime = -Infinity;
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

    setButtons(buttons: ButtonConfig[]): void {
        this.buttons = buttons;
        for (const b of buttons) {
            if (!this.dwellAccum.has(b.id)) this.dwellAccum.set(b.id, 0);
            if (!this.wasOccupied.has(b.id)) this.wasOccupied.set(b.id, false);
        }
    }

    onTrigger(cb: ButtonTriggerCallback): void {
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
        const dt = this.lastTimestamp > 0 ? now - this.lastTimestamp : 0;
        this.lastTimestamp = now;

        const events: GestureEvent[] = [];
        const handCount = result.landmarks?.length ?? 0;

        if (handCount > this.prevHandCount) {
            events.push({ type: 'hand_enter', detail: `${handCount} hand(s)` });
        } else if (handCount < this.prevHandCount) {
            events.push({ type: 'hand_leave', detail: `${handCount} hand(s)` });
        }
        this.prevHandCount = handCount;

        // Convert all hand landmarks to canvas pixel space (mirrored X)
        const handsCanvas: { x: number; y: number; z: number }[][] = [];
        const handInfos: HandDebugInfo[] = [];
        for (let h = 0; h < handCount; h++) {
            const lm = result.landmarks![h];
            const canvasLm = lm.map((pt) => ({
                x: (1 - pt.x) * this.drawW + this.offsetX,
                y: pt.y * this.drawH + this.offsetY,
                z: pt.z,
            }));
            handsCanvas.push(canvasLm);
            handInfos.push({ landmarks: canvasLm });
        }

        const buttonStates: ButtonState[] = [];
        for (const btn of this.buttons) {
            const r = btn.rect;
            let occupied = false;
            outer: for (const hand of handsCanvas) {
                for (const pt of hand) {
                    if (
                        pt.x >= r.x && pt.x <= r.x + r.w &&
                        pt.y >= r.y && pt.y <= r.y + r.h
                    ) {
                        occupied = true;
                        break outer;
                    }
                }
            }

            const wasOcc = this.wasOccupied.get(btn.id) || false;
            let accum = this.dwellAccum.get(btn.id) || 0;

            if (occupied) {
                if (!wasOcc) events.push({ type: 'button_enter', detail: btn.id });
                accum += dt;

                if (accum >= GestureDetector.DWELL_TIME) {
                    if (now - this.lastTriggerTime > GestureDetector.COOLDOWN) {
                        this.lastTriggerTime = now;
                        accum = 0;
                        events.push({ type: 'button_trigger', detail: btn.id });
                        this.triggerCallback?.(btn.id);
                    } else {
                        events.push({ type: 'cooldown_blocked', detail: btn.id });
                        accum = GestureDetector.DWELL_TIME;
                    }
                }
            } else {
                if (wasOcc) events.push({ type: 'button_leave', detail: btn.id });
                accum = Math.max(0, accum - dt * 3);
            }

            this.dwellAccum.set(btn.id, accum);
            this.wasOccupied.set(btn.id, occupied);

            buttonStates.push({
                id: btn.id,
                progress: Math.min(accum / GestureDetector.DWELL_TIME, 1),
                occupied,
            });
        }

        if (this.debugCallback) {
            this.debugCallback({
                handsDetected: handCount,
                hands: handInfos,
                buttons: buttonStates,
                cooldownRemaining: Math.max(
                    0,
                    GestureDetector.COOLDOWN - (now - this.lastTriggerTime),
                ),
                events,
            });
        }
    }

    dispose(): void {
        this.handLandmarker?.close();
        this.handLandmarker = null;
    }
}
