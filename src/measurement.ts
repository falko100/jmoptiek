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
 *   VITE_VISIT_ABSENCE_GAP_MS  — optional gap that ends a visit
 */

/**
 * Heartbeat for the day tally.
 *
 * The tally is pushed the moment it changes (see counter.onVisit below), so this
 * is only a fallback for a day where nothing happens — it keeps `lastVisitAt`
 * and the kiosk's presence fresh without anyone standing at the mirror. It used
 * to be the only cadence, which left the dashboard reading a tally up to five
 * minutes behind the visit list, with nothing on screen saying so.
 */
const DAILY_SNAPSHOT_MS = 5 * 60_000;

const KIOSK_ID_KEY = 'jm.kioskId';

/** The VITE_* values this module reads. */
export type MeasurementEnv = Partial<
    Record<
        | 'VITE_STATS_ENDPOINT'
        | 'VITE_STATS_TOKEN'
        | 'VITE_KIOSK_ID'
        | 'VITE_VISIT_MATCH_THRESHOLD'
        | 'VITE_VISIT_ABSENCE_GAP_MS',
        string
    >
>;

export interface MeasurementOptions {
    maxDistanceCm: number;
    minFaceHeightFraction: number;
    /**
     * Overrides the environment. Production leaves this unset and reads
     * import.meta.env; tests supply it, since `import.meta.env` exists only
     * under Vite and is not reachable from another module.
     */
    env?: MeasurementEnv;
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
    /** Stop the reporter's flush timer. The kiosk runs forever, tests do not. */
    dispose(): void;
}

export function createMeasurement(options: MeasurementOptions): Measurement {
    const env: MeasurementEnv = options.env ?? import.meta.env ?? {};
    const kioskId = resolveKioskId(env);

    const reporter = new StatsReporter({
        endpoint: env.VITE_STATS_ENDPOINT ?? '',
        token: env.VITE_STATS_TOKEN ?? '',
        kioskId,
    });

    const matchThreshold = Number(env.VITE_VISIT_MATCH_THRESHOLD);
    const absenceGapMs = Number(env.VITE_VISIT_ABSENCE_GAP_MS);

    const counter = new VisitorCounter({
        maxDistanceCm: options.maxDistanceCm,
        minFaceHeightFraction: options.minFaceHeightFraction,
        ...(Number.isFinite(matchThreshold) && matchThreshold > 0
            ? { matchThreshold }
            : {}),
        ...(Number.isFinite(absenceGapMs) && absenceGapMs > 0
            ? { absenceGapMs }
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
            // Visits that could not be described. uniqueFaces is the lower
            // bound on people seen; uniqueFaces + unknownFaces the upper.
            unknownFaces: day.unknownFaces,
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

        // A finished visit is the only thing that moves the tally, so push it
        // straight away. Both screens then read the same number: the visit list
        // from kiosk_visits, the dashboard from kiosk_days. The daily event is
        // an upsert guarded on queuedAt, so sending it often is harmless.
        sendDaily(counter.getDayStats(), false);
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

        dispose(): void {
            reporter.dispose();
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
function resolveKioskId(env: MeasurementEnv): string {
    const configured = env.VITE_KIOSK_ID;
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
