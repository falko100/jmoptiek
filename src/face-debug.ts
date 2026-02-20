import * as THREE from 'three';
import type { FacePose } from './types.ts';

const AXIS_LENGTH = 60;
const DOT_RADIUS = 5;

/**
 * Draws face tracking debug overlay on the webcam canvas.
 * Shows landmarks, measurements, and orientation axes.
 */
export function drawFaceDebug(
    ctx: CanvasRenderingContext2D,
    poses: FacePose[],
): void {
    ctx.save();

    for (const pose of poses) {
        const { center, faceCenter, eyeDistance, faceWidth, landmarks, quaternion } = pose;

        // ---- Eye distance line ----
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(landmarks.leftEye.x, landmarks.leftEye.y);
        ctx.lineTo(landmarks.rightEye.x, landmarks.rightEye.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // ---- Face height line ----
        ctx.strokeStyle = '#ff8800';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(landmarks.forehead.x, landmarks.forehead.y);
        ctx.lineTo(landmarks.chin.x, landmarks.chin.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // ---- Face width line ----
        ctx.strokeStyle = '#ff00ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(landmarks.leftTemple.x, landmarks.leftTemple.y);
        ctx.lineTo(landmarks.rightTemple.x, landmarks.rightTemple.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // ---- Landmark dots ----
        // Eyes — green
        drawDot(ctx, landmarks.leftEye, '#00ff88', 'L');
        drawDot(ctx, landmarks.rightEye, '#00ff88', 'R');
        // Forehead & chin — orange
        drawDot(ctx, landmarks.forehead, '#ff8800');
        drawDot(ctx, landmarks.chin, '#ff8800');
        // Temples — magenta
        drawDot(ctx, landmarks.leftTemple, '#ff00ff', 'TL');
        drawDot(ctx, landmarks.rightTemple, '#ff00ff', 'TR');
        // Nose bridge (center) — cyan
        drawDot(ctx, center, '#00ddff', 'N');
        // Face center — white
        drawDot(ctx, faceCenter, '#ffffff', '+');

        // ---- Orientation axes from quaternion ----
        const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
        const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
        const axisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);

        // Draw at nose bridge position. X = right (red), Y = up (green), Z = forward (blue)
        drawAxis(ctx, center, axisX, '#ff3333'); // X — red
        drawAxis(ctx, center, { x: -axisY.x, y: -axisY.y, z: -axisY.z }, '#33ff33'); // Y — green (flip Y for screen coords)
        drawAxis(ctx, center, axisZ, '#3388ff'); // Z — blue

        // ---- Measurement labels ----
        ctx.font = '13px monospace';
        ctx.textBaseline = 'top';

        // Eye distance label — at midpoint of eyes
        const eyeMidX = (landmarks.leftEye.x + landmarks.rightEye.x) / 2;
        const eyeMidY = (landmarks.leftEye.y + landmarks.rightEye.y) / 2;
        drawLabel(ctx, `eye3D: ${eyeDistance.toFixed(1)}px`, eyeMidX, eyeMidY - 18, '#00ff88');

        // Face height label
        const faceMidX = (landmarks.forehead.x + landmarks.chin.x) / 2;
        const faceMidY = (landmarks.forehead.y + landmarks.chin.y) / 2;
        drawLabel(ctx, `h3D: ${pose.faceHeight.toFixed(1)}px`, faceMidX + 12, faceMidY, '#ff8800');

        // Face width label
        const templeMidX = (landmarks.leftTemple.x + landmarks.rightTemple.x) / 2;
        const templeMidY = (landmarks.leftTemple.y + landmarks.rightTemple.y) / 2;
        drawLabel(ctx, `w3D: ${faceWidth.toFixed(1)}px`, templeMidX, templeMidY + 14, '#ff00ff');

        // Euler angles from quaternion for readability
        const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
        const deg = 180 / Math.PI;
        drawLabel(
            ctx,
            `pitch:${(euler.x * deg).toFixed(0)}  yaw:${(euler.y * deg).toFixed(0)}  roll:${(euler.z * deg).toFixed(0)}`,
            center.x - 80,
            center.y + AXIS_LENGTH + 12,
            '#aaaaaa',
        );
    }

    ctx.restore();
}

function drawDot(
    ctx: CanvasRenderingContext2D,
    p: { x: number; y: number },
    color: string,
    label?: string,
): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    if (label) {
        ctx.font = '10px monospace';
        ctx.fillStyle = color;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'center';
        ctx.fillText(label, p.x, p.y - DOT_RADIUS - 2);
    }
}

function drawAxis(
    ctx: CanvasRenderingContext2D,
    origin: { x: number; y: number },
    dir: { x: number; y: number; z: number },
    color: string,
): void {
    const endX = origin.x + dir.x * AXIS_LENGTH;
    const endY = origin.y + dir.y * AXIS_LENGTH;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    // Arrow head
    const angle = Math.atan2(dir.y, dir.x);
    const headLen = 8;
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(
        endX - headLen * Math.cos(angle - 0.4),
        endY - headLen * Math.sin(angle - 0.4),
    );
    ctx.moveTo(endX, endY);
    ctx.lineTo(
        endX - headLen * Math.cos(angle + 0.4),
        endY - headLen * Math.sin(angle + 0.4),
    );
    ctx.stroke();
}

function drawLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
): void {
    ctx.font = '13px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const metrics = ctx.measureText(text);
    const pad = 3;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - pad, y - pad, metrics.width + pad * 2, 16 + pad * 2);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
}
