import type { GestureDebugInfo } from './gesture-detector.ts';

/**
 * Creates two circular buttons on the left and right edges of the screen.
 * Each has an SVG ring that fills up as the hand dwells in the zone.
 */
export function createCornerButtons(): {
    update: (info: GestureDebugInfo) => void;
} {
    const leftBtn = createButton('left', '‹');
    const rightBtn = createButton('right', '›');

    document.body.appendChild(leftBtn.el);
    document.body.appendChild(rightBtn.el);

    return {
        update(info: GestureDebugInfo) {
            leftBtn.setProgress(info.leftProgress);
            rightBtn.setProgress(info.rightProgress);

            // Highlight when a hand is in the zone
            const leftOccupied = info.hands.some((h) => h.zone === 'left');
            const rightOccupied = info.hands.some((h) => h.zone === 'right');
            leftBtn.setActive(leftOccupied);
            rightBtn.setActive(rightOccupied);
        },
    };
}

function createButton(side: 'left' | 'right', arrow: string) {
    const SIZE = 80;
    const STROKE = 4;
    const RADIUS = (SIZE - STROKE) / 2;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

    const el = document.createElement('div');
    el.className = `corner-btn corner-btn-${side}`;

    // SVG ring
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(SIZE));
    svg.setAttribute('height', String(SIZE));
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);

    // Background ring
    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', String(SIZE / 2));
    bgCircle.setAttribute('cy', String(SIZE / 2));
    bgCircle.setAttribute('r', String(RADIUS));
    bgCircle.setAttribute('fill', 'none');
    bgCircle.setAttribute('stroke', 'rgba(255,255,255,0.15)');
    bgCircle.setAttribute('stroke-width', String(STROKE));
    svg.appendChild(bgCircle);

    // Progress ring
    const progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    progressCircle.setAttribute('cx', String(SIZE / 2));
    progressCircle.setAttribute('cy', String(SIZE / 2));
    progressCircle.setAttribute('r', String(RADIUS));
    progressCircle.setAttribute('fill', 'none');
    progressCircle.setAttribute('stroke', '#4ecca3');
    progressCircle.setAttribute('stroke-width', String(STROKE));
    progressCircle.setAttribute('stroke-linecap', 'round');
    progressCircle.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
    progressCircle.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
    // Rotate so progress starts from the top
    progressCircle.setAttribute('transform', `rotate(-90 ${SIZE / 2} ${SIZE / 2})`);
    svg.appendChild(progressCircle);

    el.appendChild(svg);

    // Arrow label
    const label = document.createElement('span');
    label.className = 'corner-btn-label';
    label.textContent = arrow;
    el.appendChild(label);

    return {
        el,
        setProgress(p: number) {
            const offset = CIRCUMFERENCE * (1 - p);
            progressCircle.setAttribute('stroke-dashoffset', String(offset));
        },
        setActive(active: boolean) {
            el.classList.toggle('active', active);
        },
    };
}
