import type { Measurement } from './measurement.ts';

/**
 * Live view of the visitor measurement: who is at the mirror right now,
 * today's tally, and whether events are reaching the backend.
 *
 * Toggled with the "v" key (see main.ts).
 */
export function createVisitorDebug(measurement: Measurement): {
    element: HTMLElement;
    setEnabled: (on: boolean) => void;
    update: () => void;
} {
    const panel = document.createElement('div');
    panel.id = 'visitor-debug';

    const title = document.createElement('div');
    title.className = 'gd-title';
    title.textContent = 'Visitor Debug';
    title.addEventListener('click', () => setEnabled(false));
    panel.appendChild(title);

    const stats = document.createElement('div');
    stats.className = 'gd-stats';
    panel.appendChild(stats);

    document.getElementById('camera-area')!.appendChild(panel);

    let enabled = false;

    function setEnabled(on: boolean): void {
        enabled = on;
        panel.classList.toggle('hidden', !on);
    }

    return {
        element: panel,
        setEnabled,
        update() {
            if (!enabled) return;

            const { kioskId, counter, reporter } = measurement.getState();
            const day = counter.day;

            const sending = !reporter.enabled
                ? '<span class="gd-val">off</span>'
                : reporter.lastError
                  ? `<span class="gd-val gd-hot">${escapeHtml(reporter.lastError)}</span>`
                  : `<span class="gd-val">ok</span>`;

            const lines = [
                `<span class="gd-label">Kiosk</span> <span class="gd-val">${escapeHtml(kioskId)}</span>`,
                `<span class="gd-label">Now</span> <span class="gd-val ${counter.present ? 'gd-hot' : ''}">${
                    counter.present
                        ? `face ${(counter.currentDwellMs / 1000).toFixed(1)}s · ${counter.samples} samples`
                        : 'nobody'
                }</span>`,
                `<span class="gd-label">Unique</span> <span class="gd-val gd-hot">${day.uniqueFaces}</span> <span class="gd-val">faces today</span>`,
                `<span class="gd-label">Visits</span> <span class="gd-val">${day.visits} (${day.returningVisits} terug)</span>`,
                `<span class="gd-label">Avg dwell</span> <span class="gd-val">${
                    day.visits > 0 ? (day.totalDwellMs / day.visits / 1000).toFixed(1) : '0.0'
                }s</span>`,
                `<span class="gd-label">Tracked</span> <span class="gd-val">${counter.tracked}</span>`,
                `<span class="gd-label">Queue</span> <span class="gd-val ${reporter.queued > 0 ? 'gd-hot' : ''}">${reporter.queued}</span>`,
                `<span class="gd-label">Sending</span> ${sending}`,
            ];
            stats.innerHTML = lines.join('<br>');
        },
    };
}

function escapeHtml(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
}
