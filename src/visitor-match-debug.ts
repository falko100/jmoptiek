import type { Measurement } from './measurement.ts';
import { MAX_FRONTAL_ANGLE_DEG, signatureDistance } from './face-signature.ts';
import type { MatchDiagnostics } from './visitor-counter.ts';

/**
 * Why the unique-face count is what it is.
 *
 * The visitor debug panel ("v") shows the tally; this one shows the decision
 * behind it. Two visits are merged when their face descriptors are closer than
 * the match threshold, so the count is only ever as good as that threshold —
 * and the only way to pick it is to see what real people actually score.
 *
 * Toggled with the "m" key (see main.ts).
 *
 * What to do with it: stand in front of the mirror, walk away for five seconds,
 * come back, and read "Live". That number is what a genuine return scores. The
 * threshold has to sit above it, and below whatever a different colleague
 * scores against you.
 *
 * Privacy: the descriptors this panel keeps for its replay live in memory only,
 * are never sent anywhere, and are dropped on the same 10 minute window the
 * counter uses — the panel does not weaken the guarantee in
 * docs/visitor-measurement.md.
 */

/** Thresholds shown in the what-if table. */
const CANDIDATE_THRESHOLDS = [0.02, 0.03, 0.04, 0.05, 0.06];

/** Completed visits shown in the log. */
const MAX_LOG_ROWS = 8;

/**
 * How often the panel redraws (ms).
 *
 * Every refresh recomputes the running median over ~24 samples of 66 features.
 * Doing that per frame is enough work to cost framerate — which would change the
 * very sampling you are trying to measure. Four times a second reads fine.
 */
const REFRESH_MS = 250;

/** How long a primed reset button stays primed (ms). */
const RESET_CONFIRM_MS = 3000;

interface RecordedVisit {
    at: number;
    signature: Float32Array;
}

export function createVisitorMatchDebug(measurement: Measurement): {
    element: HTMLElement;
    setEnabled: (on: boolean) => void;
    update: () => void;
} {
    const counter = measurement.counter;

    const panel = document.createElement('div');
    panel.id = 'match-debug';

    const title = document.createElement('div');
    title.className = 'gd-title';
    title.textContent = 'Match Debug';
    title.addEventListener('click', () => setEnabled(false));
    panel.appendChild(title);

    // --- threshold slider ---------------------------------------------------
    const tuner = document.createElement('div');
    tuner.className = 'md-tuner';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.005';
    slider.max = '0.1';
    slider.step = '0.0025';
    slider.value = String(counter.getMatchThreshold());

    const tunerLabel = document.createElement('div');
    tunerLabel.className = 'md-tuner-label';

    slider.addEventListener('input', () => {
        counter.setMatchThreshold(Number(slider.value));
        renderTuner();
    });
    // The kiosk listens for single-key shortcuts; don't let them fire while
    // nudging the slider with the arrow keys.
    slider.addEventListener('keydown', (e) => e.stopPropagation());

    tuner.append(tunerLabel, slider);
    panel.appendChild(tuner);

    const body = document.createElement('div');
    body.className = 'gd-stats';
    panel.appendChild(body);

    // --- reset --------------------------------------------------------------
    // A count built under the previous threshold cannot be compared with one
    // built under the new one, so tuning means starting over repeatedly.
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'md-reset';

    let resetPrimedAt = 0;

    function renderReset(): void {
        const primed = Date.now() - resetPrimedAt < RESET_CONFIRM_MS;
        resetButton.textContent = primed
            ? 'Zeker weten? Klik nogmaals'
            : 'Telling resetten';
        resetButton.classList.toggle('md-reset-primed', primed);
    }

    resetButton.addEventListener('click', () => {
        if (Date.now() - resetPrimedAt < RESET_CONFIRM_MS) {
            measurement.resetDay();
            log.length = 0;
            recorded.length = 0;
            resetPrimedAt = 0;
        } else {
            // One stray click should not wipe an afternoon of measurements.
            resetPrimedAt = Date.now();
        }
        renderReset();
    });

    panel.appendChild(resetButton);

    document.getElementById('camera-area')!.appendChild(panel);

    let enabled = false;
    let lastRenderAt = 0;
    const log: MatchDiagnostics[] = [];
    const recorded: RecordedVisit[] = [];

    counter.onMatch((info) => {
        log.unshift(info);
        if (log.length > MAX_LOG_ROWS) log.pop();

        if (info.signature) {
            recorded.push({ at: info.at, signature: info.signature });
        }
    });

    function renderTuner(): void {
        const threshold = counter.getMatchThreshold();
        tunerLabel.innerHTML =
            `<span class="gd-label">Drempel</span> ` +
            `<span class="gd-val gd-hot">${threshold.toFixed(4)}</span> ` +
            `<span class="gd-val md-note">geldt vanaf nu, telt niet terug</span>`;
    }

    function setEnabled(on: boolean): void {
        enabled = on;
        panel.classList.toggle('hidden', !on);
        if (on) renderTuner();
    }

    renderTuner();
    setEnabled(false);

    return {
        element: panel,
        setEnabled,

        update() {
            if (!enabled) return;

            const now = Date.now();
            if (now - lastRenderAt < REFRESH_MS) return;
            lastRenderAt = now;
            const { counter: state } = measurement.getState();
            const threshold = counter.getMatchThreshold();

            // Drop descriptors that fell outside the re-visit window, so the
            // replay never sees more history than the counter itself may keep.
            const cutoff = now - counter.getRevisitWindowMs();
            while (recorded.length > 0 && recorded[0].at < cutoff) recorded.shift();

            body.innerHTML = [
                renderNow(state),
                renderLive(counter.getLiveMatch(now), threshold),
                renderLog(log, now),
                renderWhatIf(recorded, counter.getRevisitWindowMs()),
            ].join('');

            renderReset();
        },
    };
}

function renderNow(state: {
    present: boolean;
    samples: number;
    frontal: boolean;
    yawDeg: number | null;
    pitchDeg: number | null;
}): string {
    if (!state.present) {
        return row('Nu', 'niemand voor de spiegel');
    }

    const yaw = state.yawDeg ?? 0;
    const pitch = state.pitchDeg ?? 0;

    // Sampling stops outside the frontal gate, so a face that is present but
    // never frontal produces a weak descriptor and a likely mismatch.
    const angles =
        `yaw ${yaw.toFixed(0)}° pitch ${pitch.toFixed(0)}° ` +
        `<span class="md-note">(max ${MAX_FRONTAL_ANGLE_DEG.toFixed(0)}°)</span>`;

    return (
        row('Nu', `${state.samples} samples`) +
        row(
            'Frontaal',
            state.frontal
                ? `<span class="gd-hot">ja</span> · ${angles}`
                : `<span class="md-warn">nee</span> · ${angles}`,
        )
    );
}

function renderLive(
    live: { hasSignature: boolean; distances: { distance: number; ageMs: number }[] },
    threshold: number,
): string {
    if (!live.hasSignature) {
        return row('Live', '<span class="md-note">nog geen bruikbare samples</span>');
    }
    if (live.distances.length === 0) {
        return row('Live', '<span class="md-note">niets om mee te vergelijken</span>');
    }

    // The nearest tracked face is the one this visit would be merged with.
    const lines = live.distances
        .slice(0, 4)
        .map((d, i) => {
            const hit = d.distance <= threshold;
            const cls = hit ? 'gd-hot' : 'md-warn';
            const verdict = hit ? 'MATCH' : 'nieuw';
            const label = i === 0 ? 'Live' : '';
            return row(
                label,
                `<span class="${cls}">${d.distance.toFixed(4)}</span> ` +
                    `<span class="md-note">${ago(d.ageMs)} · ${verdict}</span>`,
            );
        });

    return lines.join('');
}

function renderLog(log: MatchDiagnostics[], now: number): string {
    if (log.length === 0) {
        return heading('Afgeronde bezoeken') + row('', '<span class="md-note">nog geen</span>');
    }

    const rows = log.map((info) => {
        const distance =
            info.bestDistance === null
                ? '<span class="md-note">eerste</span>'
                : `<span class="${info.matched ? 'gd-hot' : 'md-warn'}">${info.bestDistance.toFixed(4)}</span>`;

        return row(
            ago(now - info.at),
            `${(info.durationMs / 1000).toFixed(1)}s · ${distance} · ` +
                `${info.matched ? 'terug' : '<span class="md-warn">NIEUW</span>'} ` +
                `<span class="md-note">${info.samples}s</span>`,
        );
    });

    return heading('Afgeronde bezoeken') + rows.join('');
}

/**
 * Replays the exact matching algorithm over the recorded visits at several
 * thresholds, so you can see what the count would have been without waiting
 * for another afternoon of visitors.
 */
function renderWhatIf(recorded: RecordedVisit[], windowMs: number): string {
    if (recorded.length < 2) {
        return (
            heading('Wat-als') +
            row('', '<span class="md-note">minstens 2 bezoeken nodig</span>')
        );
    }

    const rows = CANDIDATE_THRESHOLDS.map((threshold) => {
        const unique = replayUnique(recorded, threshold, windowMs);
        return row(
            threshold.toFixed(3),
            `<span class="gd-val">${unique}</span> uniek ` +
                `<span class="md-note">van ${recorded.length} bezoeken</span>`,
        );
    });

    return heading(`Wat-als (${recorded.length} bezoeken in venster)`) + rows.join('');
}

/** Mirrors VisitorCounter.matchAndTrack exactly, so the numbers are real. */
function replayUnique(
    visits: RecordedVisit[],
    threshold: number,
    windowMs: number,
): number {
    const tracked: { signature: Float32Array; lastSeenAt: number }[] = [];
    let unique = 0;

    for (const visit of visits) {
        const cutoff = visit.at - windowMs;
        for (let i = tracked.length - 1; i >= 0; i--) {
            if (tracked[i].lastSeenAt < cutoff) tracked.splice(i, 1);
        }

        let best: { signature: Float32Array; lastSeenAt: number } | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const face of tracked) {
            const d = signatureDistance(visit.signature, face.signature);
            if (d < bestDist) {
                bestDist = d;
                best = face;
            }
        }

        if (best && bestDist <= threshold) {
            best.lastSeenAt = visit.at;
        } else {
            tracked.push({ signature: visit.signature, lastSeenAt: visit.at });
            unique++;
        }
    }

    return unique;
}

function row(label: string, value: string): string {
    return `<div class="md-row"><span class="gd-label">${label}</span><span class="gd-val">${value}</span></div>`;
}

function heading(text: string): string {
    return `<div class="md-heading">${text}</div>`;
}

function ago(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
}
