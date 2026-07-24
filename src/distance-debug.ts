import type { FacePose } from './types.ts';

/**
 * Live distance debugger.
 *
 * Shows how far the nearest face is from the camera (in cm), the required
 * "stand within" threshold (MAX_FACE_DISTANCE), and whether the user is
 * currently in range — the same test that drives the "Ga op de voetstappen
 * staan" overlay in main.ts.
 *
 * When enabled, it also prints the live distance underneath the footprints
 * on that overlay, so you can read how far the user is standing while they're
 * being told to step closer.
 */
export function createDistanceDebug(maxDistance: number): {
    element: HTMLElement;
    setEnabled: (on: boolean) => void;
    update: (poses: FacePose[]) => void;
} {
    const panel = document.createElement('div');
    panel.id = 'distance-debug';

    const title = document.createElement('div');
    title.className = 'gd-title';
    title.textContent = 'Distance Debug';
    title.addEventListener('click', () => setEnabled(false));
    panel.appendChild(title);

    const stats = document.createElement('div');
    stats.className = 'gd-stats';
    panel.appendChild(stats);

    document.getElementById('camera-area')!.appendChild(panel);

    // Readout that appears underneath the feet on the "step closer" overlay.
    const overlayReadout = document.getElementById('overlay-distance')!;

    let enabled = false;

    function setEnabled(on: boolean): void {
        enabled = on;
        panel.classList.toggle('hidden', !on);
        overlayReadout.classList.toggle('hidden', !on);
    }

    // Scale bar spans 0 .. 2 * threshold so the threshold sits at the midpoint.
    const barMax = maxDistance * 2;

    function bar(dist: number): string {
        const filled = Math.round(Math.min(dist / barMax, 1) * 20);
        return '█'.repeat(filled).padEnd(20, '░');
    }

    return {
        element: panel,
        setEnabled,
        update(poses: FacePose[]) {
            if (!enabled) return;

            if (poses.length === 0) {
                stats.innerHTML =
                    '<span class="gd-label">Face</span> <span class="gd-val">none</span>';
                overlayReadout.textContent = 'geen gezicht';
                overlayReadout.classList.remove('overlay-distance--near');
                return;
            }

            // Nearest face is the one that decides in/out of range.
            const nearest = poses.reduce((a, b) => (b.distance < a.distance ? b : a));
            const dist = nearest.distance;
            const inRange = dist <= maxDistance;
            const cls = inRange ? '' : 'gd-hot';
            const status = inRange ? 'IN RANGE' : 'TOO FAR';

            const lines = [
                `<span class="gd-label">Distance</span> <span class="gd-val ${cls}">${dist.toFixed(1)} cm</span>`,
                `<span class="gd-label">Threshold</span> <span class="gd-val">${maxDistance} cm</span>`,
                `<span class="gd-label">Status</span> <span class="gd-val ${cls}">${status}</span>`,
                `<span class="gd-label">Faces</span> <span class="gd-val">${poses.length}</span>`,
                `<span class="gd-val gd-bar ${cls}">${bar(dist)}</span>`,
            ];
            stats.innerHTML = lines.join('<br>');

            overlayReadout.textContent = `${dist.toFixed(0)} cm  (max ${maxDistance} cm)`;
            overlayReadout.classList.toggle('overlay-distance--near', inRange);
        },
    };
}
