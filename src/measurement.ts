import type { FacePose } from './types.ts';
import {
    VisitorCounter,
    randomId,
    type CounterState,
    type DayStats,
    type VisitRecord,
} from './visitor-counter.ts';
import { StatsReporter, type ReporterState } from './stats-reporter.ts';

/**
 * Wires the visitor counter to the backend reporter.
 *
 * Two kinds of events go out:
 *   - `visit`  — one per person who stood at the mirror (see visitor-counter).
 *   - `daily`  — the running tally for the day, resent periodically so the
 *                backend always has a correct total even if single visit
 *                events were lost. Upsert it on (kioskId, date).
 *
 * Configure via .env (see .env.example):
 *   VITE_STATS_ENDPOINT  — collector URL; empty means "measure but don't send"
 *   VITE_STATS_TOKEN     — optional bearer token
 *   VITE_KIOSK_ID        — which mirror this is; auto-generated when unset
 *   VITE_VISIT_MATCH_THRESHOLD — optional re-visit sensitivity (see below)
 */

/** How often the running day tally is pushed, when it changed. */
const DAILY_SNAPSHOT_MS = 5 * 60_000;

const KIOSK_ID_KEY = 'jm.kioskId';

export interface MeasurementOptions {
    maxDistanceCm: number;
    minFaceHeightFraction: number;
}

export interface Measurement {
    /** Call once per frame from the render loop. */
    update(poses: FacePose[], frameH: number): void;
    getState(): { kioskId: string; counter: CounterState; reporter: ReporterState };
    /** Today's tally, e.g. to show it on screen. */
    getDayStats(): DayStats;
    /** The counter itself — the match debug panel needs its diagnostics API. */
    readonly counter: VisitorCounter;
    /** Wipe today's tally here and at the backend. See the match debug panel. */
    resetDay(): void;
}

export function createMeasurement(options: MeasurementOptions): Measurement {
    const kioskId = resolveKioskId();

    const reporter = new StatsReporter({
        endpoint: import.meta.env.VITE_STATS_ENDPOINT ?? '',
        token: import.meta.env.VITE_STATS_TOKEN ?? '',
        kioskId,
    });

    const matchThreshold = Number(import.meta.env.VITE_VISIT_MATCH_THRESHOLD);

    const counter = new VisitorCounter({
        maxDistanceCm: options.maxDistanceCm,
        minFaceHeightFraction: options.minFaceHeightFraction,
        ...(Number.isFinite(matchThreshold) && matchThreshold > 0
            ? { matchThreshold }
            : {}),
    });

    let lastSnapshot = '';
    let lastSnapshotAt = 0;

    function buildDaily(day: DayStats, final: boolean) {
        return {
            type: 'daily' as const,
            kioskId,
            date: day.date,
            uniqueFaces: day.uniqueFaces,
            visits: day.visits,
            returningVisits: day.returningVisits,
            totalDwellMs: day.totalDwellMs,
            averageDwellMs: day.visits > 0 ? Math.round(day.totalDwellMs / day.visits) : 0,
            firstVisitAt: day.firstVisitAt,
            lastVisitAt: day.lastVisitAt,
            /** True for the closing snapshot of a finished day. */
            final,
            timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        };
    }

    function sendDaily(day: DayStats, final: boolean): void {
        lastSnapshot = JSON.stringify(buildDaily(day, false));
        lastSnapshotAt = Date.now();
        reporter.send(buildDaily(day, final));
    }

    counter.onVisit((visit: VisitRecord) => {
        reporter.send({ type: 'visit', kioskId, ...visit });
    });

    counter.onDayRollover((day) => {
        if (day.visits > 0) sendDaily(day, true);
        lastSnapshot = '';
        lastSnapshotAt = 0;
    });

    // Close the running visit and push a final tally when the kiosk is closed
    // or reloaded, so a day never ends on a stale snapshot.
    const onLeave = () => {
        counter.flushVisit();
        const day = counter.getDayStats();
        if (day.visits > 0) sendDaily(day, false);
        // The reporter registered its own leave handler first, so push the
        // events we just queued out ourselves.
        void reporter.flush({ force: true });
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') onLeave();
    });
    window.addEventListener('pagehide', onLeave);

    return {
        counter,

        update(poses: FacePose[], frameH: number): void {
            counter.update(poses, frameH);

            const now = Date.now();
            if (now - lastSnapshotAt < DAILY_SNAPSHOT_MS) return;

            const day = counter.getDayStats();
            if (day.visits === 0) return;

            // Only resend when the tally actually changed.
            if (JSON.stringify(buildDaily(day, false)) === lastSnapshot) {
                lastSnapshotAt = now;
                return;
            }
            sendDaily(day, false);
        },

        getState() {
            return {
                kioskId,
                counter: counter.getState(),
                reporter: reporter.getState(),
            };
        },

        getDayStats() {
            return counter.getDayStats();
        },

        resetDay(): void {
            counter.reset();
            // Queued events describe the visits being wiped; delivering them
            // afterwards would put the old numbers straight back.
            reporter.clearQueue();
            lastSnapshot = '';
            lastSnapshotAt = 0;
            // Push the cleared tally right away. sendDaily normally only fires
            // for a day with visits, so without this the backend would keep
            // showing the old count until the next visitor walked in.
            sendDaily(counter.getDayStats(), false);
        },
    };
}

/** Env-configured id, else a stable random one kept in localStorage. */
function resolveKioskId(): string {
    const configured = import.meta.env.VITE_KIOSK_ID;
    if (configured) return configured;
    try {
        const stored = localStorage.getItem(KIOSK_ID_KEY);
        if (stored) return stored;
        const fresh = `kiosk-${randomId()}`;
        localStorage.setItem(KIOSK_ID_KEY, fresh);
        return fresh;
    } catch {
        return 'kiosk-unknown';
    }
}
