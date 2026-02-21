import './style.css';
import { Camera } from './camera.ts';
import { FaceTracker } from './face-tracker.ts';
import { WebcamRenderer } from './webcam-renderer.ts';
import { GlassesRenderer } from './glasses-renderer.ts';
import { GestureDetector } from './gesture-detector.ts';
import { createTweakPanel } from './tweak-panel.ts';
import { createModelSelector, type ModelSelector } from './model-selector.ts';
import { createGestureDebug } from './gesture-debug.ts';
import { createCornerButtons } from './corner-buttons.ts';
import { drawFaceDebug } from './face-debug.ts';

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

// ---------------------------------------------------------------------------
// Canvas sizing — full screen, video covers with aspect ratio preserved
// ---------------------------------------------------------------------------

function sizeCanvases(): void {
    if (!camera.isActive) return;

    const viewW = document.documentElement.clientWidth;
    const viewH = document.documentElement.clientHeight;

    webcamRenderer.setSize(viewW, viewH);
    glassesRenderer.setSize(viewW, viewH);
}

window.addEventListener('resize', sizeCanvases);

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

        if (showFaceDebug && poses.length > 0) {
            const ctx = webcamCanvas.getContext('2d');
            if (ctx) drawFaceDebug(ctx, poses);
        }
    }

    if (gestureReady) {
        gesture.setVisibleBounds(
            webcamRenderer.coverDrawW,
            webcamRenderer.coverDrawH,
            webcamRenderer.coverOffsetX,
            webcamRenderer.coverOffsetY,
            webcamCanvas.width,
            webcamCanvas.height,
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

        // Corner buttons + gesture detection
        const cornerButtons = createCornerButtons();
        const gestureDebug = createGestureDebug();

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
            gesture.onButton((side) => {
                if (side === 'right') {
                    selector.next();
                } else {
                    selector.prev();
                }
            });
            gesture.onDebug((info) => {
                cornerButtons.update(info);
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
