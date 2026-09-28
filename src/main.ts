import './style.css';
import { Camera } from './camera.ts';
import { FaceTracker } from './face-tracker.ts';
import { WebcamRenderer } from './webcam-renderer.ts';
import { GlassesRenderer } from './glasses-renderer.ts';
import { GestureDetector } from './gesture-detector.ts';
import { createTweakPanel } from './tweak-panel.ts';
import { createModelSelector, type ModelSelector } from './model-selector.ts';
import { createGestureDebug } from './gesture-debug.ts';
import { createDistanceDebug } from './distance-debug.ts';
import { createCanvasButtons } from './canvas-buttons.ts';
import { createMeasurement } from './measurement.ts';
import { createVisitorDebug } from './visitor-debug.ts';
import { createVisitorMatchDebug } from './visitor-match-debug.ts';
import { drawFaceDebug } from './face-debug.ts';
import { drawHandDebug } from './hand-debug.ts';
import { isFacePresent } from './visitor-counter.ts';
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
let distanceDebug: ReturnType<typeof createDistanceDebug> | null = null;
let visitorDebug: ReturnType<typeof createVisitorDebug> | null = null;
let matchDebug: ReturnType<typeof createVisitorMatchDebug> | null = null;

const noFaceOverlay = document.getElementById('no-face-overlay')!;
let lastFaceSeenAt = 0;
const NO_FACE_DELAY_MS = 1500;
const MAX_FACE_DISTANCE = 95;
// A child's head is smaller than the canonical model MediaPipe uses, so its
// estimated cm distance is over-stated and a kid at the mirror reads as "too
// far". As a head-size-independent fallback, also count a face as close enough
// when it simply fills enough of the frame (forehead-to-chin ≥ this fraction of
// the visible height) — tune if passers-by trigger it or kids still don't.
const MIN_FACE_HEIGHT_FRACTION = 0.22;

// Counts how many different faces the mirror sees per day and ships the numbers
// to the backend. Runs on the same presence rule as the overlay above.
const measurement = createMeasurement({
    maxDistanceCm: MAX_FACE_DISTANCE,
    minFaceHeightFraction: MIN_FACE_HEIGHT_FRACTION,
});

// ---------------------------------------------------------------------------
// Canvas sizing — full screen, video covers with aspect ratio preserved
// ---------------------------------------------------------------------------

const APP_W = 1080;
const APP_H = 1920;
const CAMERA_SIZE = 1000;
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

        // Visible frame height in canvas px (cover-mapped video height).
        const frameH = webcamRenderer.coverDrawH || CAMERA_SIZE;
        distanceDebug?.update(poses, frameH);

        measurement.update(poses, frameH);
        visitorDebug?.update();
        matchDebug?.update();

        const closeEnough = poses.some(p =>
            isFacePresent(p, frameH, MAX_FACE_DISTANCE, MIN_FACE_HEIGHT_FRACTION),
        );
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

        statusEl.textContent = 'Brillen laden…';
        const selector: ModelSelector = createModelSelector(glassesRenderer);

        // Preload progress bar
        const preloadBar = document.getElementById('preload-bar')!;
        const preloadFill = document.getElementById('preload-bar-fill')!;
        preloadBar.classList.remove('hidden');
        await selector.init((loaded, total) => {
            preloadFill.style.width = `${Math.round((loaded / total) * 100)}%`;
            statusEl.textContent = `Brillen laden… ${loaded}/${total}`;
        });
        preloadBar.classList.add('hidden');

        const tweakPanel = createTweakPanel(glassesRenderer);
        selector.setTweakPanel(tweakPanel);

        // On-screen buttons (tap) + debug panels
        const canvasButtons = createCanvasButtons();
        const gestureDebug = createGestureDebug();
        distanceDebug = createDistanceDebug(MAX_FACE_DISTANCE, MIN_FACE_HEIGHT_FRACTION);
        visitorDebug = createVisitorDebug(measurement);
        matchDebug = createVisitorMatchDebug(measurement);

        // Bottom info bar — shows the currently selected glasses.
        const infoName = document.getElementById('glasses-info-name')!;
        const infoCount = document.getElementById('glasses-info-count')!;

        // Category indicator in the header index (reflects glasses/sunglasses).
        const typeGlassesEl = document.getElementById('gi-type-glasses')!;
        const typeSunglassesEl = document.getElementById('gi-type-sunglasses')!;

        selector.onChange((change) => {
            canvasButtons.setModel(change.shortName);
            infoName.textContent = change.name;
            infoCount.textContent = `${change.index + 1} / ${change.total}`;
            typeGlassesEl.classList.toggle('active', change.type === 'glasses');
            typeSunglassesEl.classList.toggle('active', change.type === 'sunglasses');
        });
        selector.refresh(); // populate QR + info bar + indicator with the initial model
        canvasButtons.onQR(() => {
            // TODO: open booking link / QR
        });

        // Start hidden
        tweakPanel.element.classList.add('hidden');
        gestureDebug.element.classList.add('hidden');
        distanceDebug.setEnabled(false);
        visitorDebug.setEnabled(false);
        matchDebug.setEnabled(false);

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
            if (e.key === 'g' || e.key === 'G') {
                const isEnabled = !distanceDebug!.element.classList.contains('hidden');
                distanceDebug!.setEnabled(!isEnabled);
            }
            if (e.key === 'v' || e.key === 'V') {
                const isEnabled = !visitorDebug!.element.classList.contains('hidden');
                visitorDebug!.setEnabled(!isEnabled);
                visitorDebug!.update();
            }
            // Why the unique count is what it is — see visitor-match-debug.ts.
            if (e.key === 'm' || e.key === 'M') {
                const isEnabled = !matchDebug!.element.classList.contains('hidden');
                matchDebug!.setEnabled(!isEnabled);
                matchDebug!.update();
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
            gesture.onTrigger((action) => {
                switch (action) {
                    case 'next': selector.next(); break;
                    case 'prev': selector.prev(); break;
                    case 'type': selector.toggleType(); break;
                }
            });
            gesture.onDebug((info) => {
                latestGestureDebug = info;
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
