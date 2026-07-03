import './style.css';
import { Camera } from './camera.ts';
import { FaceTracker } from './face-tracker.ts';
import { WebcamRenderer } from './webcam-renderer.ts';
import { GlassesRenderer } from './glasses-renderer.ts';
import { GestureDetector } from './gesture-detector.ts';
import { createTweakPanel } from './tweak-panel.ts';
import { createModelSelector, type ModelSelector } from './model-selector.ts';
import { createGestureDebug } from './gesture-debug.ts';
import { createCanvasButtons } from './canvas-buttons.ts';
import { drawFaceDebug } from './face-debug.ts';
import { drawHandDebug } from './hand-debug.ts';
import type { GestureDebugInfo } from './gesture-detector.ts';

// DOM elements
const webcamCanvas = document.getElementById('webcam-canvas') as HTMLCanvasElement;
const glassesCanvas = document.getElementById('glasses-canvas') as HTMLCanvasElement;
const video = document.getElementById('webcam') as HTMLVideoElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

// Core modules
const camera = new Camera(video);
const tracker = new FaceTracker();
const gesture = new GestureDetector();
const webcamRenderer = new WebcamRenderer(webcamCanvas);
const glassesRenderer = new GlassesRenderer(glassesCanvas);

let trackerReady = false;
let gestureReady = false;
let showFaceDebug = false;
let latestGestureDebug: GestureDebugInfo | null = null;

const noFaceOverlay = document.getElementById('no-face-overlay')!;
let lastFaceSeenAt = 0;
const NO_FACE_DELAY_MS = 1500;
const MAX_FACE_DISTANCE = 60;

// ---------------------------------------------------------------------------
// Canvas sizing — full screen, video covers with aspect ratio preserved
// ---------------------------------------------------------------------------

const APP_W = 1080;
const APP_H = 1920;
const CAMERA_SIZE = 820;
const appEl = document.getElementById('app') as HTMLDivElement;

function scaleApp(): void {
    // Prefer the visual viewport (iOS Safari accounts for the URL bar there),
    // falling back to the layout viewport.
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const scale = Math.min(vw / APP_W, vh / APP_H);
    appEl.style.transform = `scale(${scale})`;
}

scaleApp();
window.addEventListener('resize', scaleApp);
window.addEventListener('orientationchange', scaleApp);
window.visualViewport?.addEventListener('resize', scaleApp);
// iOS sometimes reports a stale innerHeight on first paint — re-fit once settled.
window.addEventListener('load', scaleApp);

function sizeCanvases(): void {
    if (!camera.isActive) return;
    webcamRenderer.setSize(CAMERA_SIZE, CAMERA_SIZE);
    glassesRenderer.setSize(CAMERA_SIZE, CAMERA_SIZE);
}


// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let faceTimestamp = 0;
let gestureTimestamp = 0;

function renderLoop(): void {
    if (!camera.isActive) return;

    webcamRenderer.drawFrame(video);

    const now = performance.now();

    if (trackerReady) {
        faceTimestamp = Math.max(faceTimestamp + 1, Math.floor(now));
        const result = tracker.detect(video, faceTimestamp);
        const poses = tracker.computePoses(
            result,
            webcamRenderer.coverDrawW,
            webcamRenderer.coverDrawH,
            webcamRenderer.coverOffsetX,
            webcamRenderer.coverOffsetY,
        );
        glassesRenderer.render(poses);

        const closeEnough = poses.some(p => p.distance <= MAX_FACE_DISTANCE);
        if (closeEnough) {
            lastFaceSeenAt = now;
            noFaceOverlay.classList.add('hidden');
        } else if (now - lastFaceSeenAt > NO_FACE_DELAY_MS) {
            noFaceOverlay.classList.remove('hidden');
        }

        if (showFaceDebug) {
            const ctx = webcamCanvas.getContext('2d');
            if (ctx) {
                if (poses.length > 0) drawFaceDebug(ctx, poses);
                if (latestGestureDebug && latestGestureDebug.hands.length > 0) {
                    drawHandDebug(ctx, latestGestureDebug.hands);
                }
            }
        }
    }

    if (gestureReady) {
        gesture.setVisibleBounds(
            webcamRenderer.coverDrawW,
            webcamRenderer.coverDrawH,
            webcamRenderer.coverOffsetX,
            webcamRenderer.coverOffsetY,
        );
        gestureTimestamp = Math.max(gestureTimestamp + 1, Math.floor(now) + 1);
        gesture.detect(video, gestureTimestamp);
    }

    requestAnimationFrame(renderLoop);
}

// ---------------------------------------------------------------------------
// Auto-start on page load
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
    try {
        statusEl.textContent = 'Requesting camera access...';
        await camera.start();
        sizeCanvases();

        statusEl.textContent = 'Loading face detection model...';
        await tracker.init();
        trackerReady = true;

        statusEl.textContent = 'Loading 3D models...';
        const selector: ModelSelector = createModelSelector(glassesRenderer);
        await selector.init();

        const tweakPanel = createTweakPanel(glassesRenderer);
        selector.setTweakPanel(tweakPanel);

        // Canvas-edge buttons (touch via click or hand-dwell)
        const canvasButtons = createCanvasButtons();
        const gestureDebug = createGestureDebug();

        canvasButtons.onPrev(() => selector.prev());
        canvasButtons.onNext(() => selector.next());
        selector.onChange((shortName) => canvasButtons.setModel(shortName));
        canvasButtons.setModel(selector.currentShortName());
        canvasButtons.onTypeChange((_type) => {
            // TODO: filter models by category once sunglasses models exist
        });
        canvasButtons.onPaszone(() => {
            // TODO: paszone calibration flow
        });
        canvasButtons.onQR(() => {
            // TODO: open booking link / QR
        });

        // Start hidden
        tweakPanel.element.classList.add('hidden');
        gestureDebug.element.classList.add('hidden');

        // Toggle debug UIs with keyboard shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.key === 'd' || e.key === 'D') {
                gestureDebug.element.classList.toggle('hidden');
            }
            if (e.key === 't' || e.key === 'T') {
                tweakPanel.element.classList.toggle('hidden');
            }
            if (e.key === 'f' || e.key === 'F') {
                showFaceDebug = !showFaceDebug;
            }
        });

        // Long-press on webcam canvas toggles both debug panels
        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        const LONG_PRESS_MS = 500;

        webcamCanvas.addEventListener('pointerdown', () => {
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                const bothHidden =
                    tweakPanel.element.classList.contains('hidden') &&
                    gestureDebug.element.classList.contains('hidden');
                if (bothHidden) {
                    tweakPanel.element.classList.remove('hidden');
                    gestureDebug.element.classList.remove('hidden');
                } else {
                    tweakPanel.element.classList.add('hidden');
                    gestureDebug.element.classList.add('hidden');
                }
            }, LONG_PRESS_MS);
        });
        const cancelLongPress = () => {
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };
        webcamCanvas.addEventListener('pointerup', cancelLongPress);
        webcamCanvas.addEventListener('pointercancel', cancelLongPress);
        webcamCanvas.addEventListener('pointermove', cancelLongPress);

        statusEl.textContent = 'Loading gesture detection...';
        gesture.init().then(() => {
            gestureReady = true;
            gesture.setButtons(canvasButtons.getButtonConfigs());
            gesture.onTrigger((id) => canvasButtons.trigger(id));
            gesture.onDebug((info) => {
                latestGestureDebug = info;
                for (const btn of info.buttons) {
                    canvasButtons.setProgress(btn.id, btn.progress);
                }
                gestureDebug.update(info);
            });
        });

        statusEl.classList.add('hidden');
        renderLoop();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Start error:', err);
        statusEl.textContent = `Error: ${message}`;
    }
}

start();
