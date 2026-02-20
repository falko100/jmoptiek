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

// ---------------------------------------------------------------------------
// Canvas sizing — fill the viewport with "cover" behaviour
// ---------------------------------------------------------------------------

function sizeCanvases(): void {
    if (!camera.isActive) return;

    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const videoAspect = camera.videoWidth / camera.videoHeight;
    const viewAspect = viewW / viewH;

    let drawW: number;
    let drawH: number;
    if (viewAspect > videoAspect) {
        drawW = viewW;
        drawH = viewW / videoAspect;
    } else {
        drawH = viewH;
        drawW = viewH * videoAspect;
    }

    webcamRenderer.setSize(drawW, drawH);
    glassesRenderer.setSize(drawW, drawH);
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
        const poses = tracker.computePoses(result, webcamCanvas.width, webcamCanvas.height);
        glassesRenderer.render(poses);
    }

    if (gestureReady) {
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
        await glassesRenderer.loadOccluder('/canonical.glb');
        const selector: ModelSelector = createModelSelector(glassesRenderer);
        await selector.init();

        const tweakPanel = createTweakPanel(glassesRenderer);
        selector.setTweakPanel(tweakPanel);

        // Corner buttons + gesture detection
        const cornerButtons = createCornerButtons();
        const gestureDebug = createGestureDebug();

        // Toggle debug UIs with keyboard shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.key === 'd' || e.key === 'D') {
                // Toggle gesture debug panel
                gestureDebug.element.classList.toggle('hidden');
            }
            if (e.key === 't' || e.key === 'T') {
                // Toggle tweak panel
                tweakPanel.element.classList.toggle('hidden');
            }
        });

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
