import type { HandDebugInfo } from './gesture-detector.ts';

const HAND_CONNECTIONS: [number, number][] = [
    // Thumb
    [0, 1], [1, 2], [2, 3], [3, 4],
    // Index
    [0, 5], [5, 6], [6, 7], [7, 8],
    // Middle
    [0, 9], [9, 10], [10, 11], [11, 12],
    // Ring
    [0, 13], [13, 14], [14, 15], [15, 16],
    // Pinky
    [0, 17], [17, 18], [18, 19], [19, 20],
    // Palm
    [5, 9], [9, 13], [13, 17],
];

const FINGER_COLORS = [
    '#ff4444', // thumb
    '#ff8800', // index
    '#ffff00', // middle
    '#44ff44', // ring
    '#4488ff', // pinky
];

const EDGE_THRESHOLD = 0.06;
const EDGE_GLOW_DEPTH = 24;
const EDGE_GLOW_SPREAD = 60;
const EDGE_COLOR = [0, 220, 255] as const;
const EDGE_ALPHA = 0.6;

type Edge = 'left' | 'right' | 'top' | 'bottom';

interface EdgeTouch {
    edge: Edge;
    along: number;
}

function fingerColor(idx: number): string {
    if (idx <= 4) return FINGER_COLORS[0];
    if (idx <= 8) return FINGER_COLORS[1];
    if (idx <= 12) return FINGER_COLORS[2];
    if (idx <= 16) return FINGER_COLORS[3];
    return FINGER_COLORS[4];
}

function drawEdgeSpot(ctx: CanvasRenderingContext2D, edge: Edge, along: number, cw: number, ch: number): void {
    const [r, g, b] = EDGE_COLOR;
    const spread = EDGE_GLOW_SPREAD;
    const depth = EDGE_GLOW_DEPTH;

    ctx.save();

    if (edge === 'left' || edge === 'right') {
        const x = edge === 'left' ? 0 : cw;
        const grad = ctx.createRadialGradient(x, along, 0, x, along, spread);
        grad.addColorStop(0, `rgba(${r},${g},${b},${EDGE_ALPHA})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(
            edge === 'left' ? 0 : cw - depth,
            along - spread,
            depth,
            spread * 2,
        );
    } else {
        const y = edge === 'top' ? 0 : ch;
        const grad = ctx.createRadialGradient(along, y, 0, along, y, spread);
        grad.addColorStop(0, `rgba(${r},${g},${b},${EDGE_ALPHA})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(
            along - spread,
            edge === 'top' ? 0 : ch - depth,
            spread * 2,
            depth,
        );
    }

    ctx.restore();
}

/**
 * Draws hand landmarks on the webcam canvas.
 * Landmarks are already in canvas pixel space — no conversion needed.
 */
export function drawHandDebug(
    ctx: CanvasRenderingContext2D,
    hands: HandDebugInfo[],
): void {
    ctx.save();

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const touches: EdgeTouch[] = [];

    for (const hand of hands) {
        const lm = hand.landmarks;
        if (!lm || lm.length < 21) continue;

        // Collect edge touches from all landmarks
        const threshX = cw * EDGE_THRESHOLD;
        const threshY = ch * EDGE_THRESHOLD;
        for (const pt of lm) {
            if (pt.x < threshX) touches.push({ edge: 'left', along: pt.y });
            if (pt.x > cw - threshX) touches.push({ edge: 'right', along: pt.y });
            if (pt.y < threshY) touches.push({ edge: 'top', along: pt.x });
            if (pt.y > ch - threshY) touches.push({ edge: 'bottom', along: pt.x });
        }

        // Connections
        ctx.lineWidth = 2;
        for (const [a, b] of HAND_CONNECTIONS) {
            ctx.strokeStyle = fingerColor(Math.max(a, b));
            ctx.beginPath();
            ctx.moveTo(lm[a].x, lm[a].y);
            ctx.lineTo(lm[b].x, lm[b].y);
            ctx.stroke();
        }

        // Landmark dots
        for (let i = 0; i < lm.length; i++) {
            const p = lm[i];
            ctx.fillStyle = fingerColor(i);
            ctx.beginPath();
            ctx.arc(p.x, p.y, i === 0 ? 5 : 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Draw localized edge glow at each touch point
    for (const touch of touches) {
        drawEdgeSpot(ctx, touch.edge, touch.along, cw, ch);
    }

    ctx.restore();
}
