import type { FacePose } from './types.ts';
import {
    computeFaceSignature,
    medianSignature,
    signatureDistance,
} from './face-signature.ts';

/**
 * Counts how many different faces the mirror sees.
 *
 * A "visit" is one uninterrupted stretch of somebody standing in front of the
 * mirror, close enough that the app would show them glasses. Short tracking
 * drops are tolerated; walking away ends the visit.
 *
 * When a visit ends we compare its face signature against the visits from the
 * last `revisitWindowMs`. A match means the same person came back (someone
 * fetching a friend, a second try after a phone call) and it does not bump the
 * unique-face count. Signatures live in memory only and are dropped as soon as
 * they fall outside that window.
 */

export interface VisitorCounterOptions {
    /** Face counts as present at or below this camera distance (cm). */
    maxDistanceCm: number;
    /** …or when forehead-to-chin covers at least this fraction of the frame. */
    minFaceHeightFraction: number;
    /** Presence must hold this long before it counts as a visit (ms). */
    minPresenceMs?: number;
    /** Absence this long ends the running visit (ms). */
    absenceGapMs?: number;
    /** How long a finished visit stays comparable for re-visit matching (ms). */
    revisitWindowMs?: number;
    /**
     * Signature distance below which two visits count as the same person.
     * Deliberately tight: merging two different visitors silently loses one,
     * while failing to merge a returning visitor only inflates the count by
     * someone who really was there. Tune with VITE_VISIT_MATCH_THRESHOLD.
     */
    matchThreshold?: number;
    /** Max signature samples kept per visit. */
    maxSamplesPerVisit?: number;
    /** localStorage key for the running day tally. */
    storageKey?: string;
}

/** One completed visit. Contains no biometric data — safe to send onward. */
export interface VisitRecord {
    visitId: string;
    /** Local day the visit started on, as YYYY-MM-DD. */
    date: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    /** True when this face was already seen within the re-visit window. */
    returning: boolean;
    /** Nth visit of the day (1-based). */
    sequence: number;
}

/** Running tally for one local day. */
export interface DayStats {
    date: string;
    /** Visits whose face was not matched to an earlier visit that day. */
    uniqueFaces: number;
    /** All visits, including people who came back. */
    visits: number;
    returningVisits: number;
    totalDwellMs: number;
    firstVisitAt: string | null;
    lastVisitAt: string | null;
}

/** Live state, for the debug panel. */
export interface CounterState {
    present: boolean;
    /** How long the current visit has been running (ms), 0 when nobody is there. */
    currentDwellMs: number;
    /** Signature samples collected for the running visit. */
    samples: number;
    /** Finished visits still inside the re-visit window. */
    tracked: number;
    day: DayStats;
}

const DEFAULTS = {
    minPresenceMs: 1200,
    absenceGapMs: 2500,
    revisitWindowMs: 10 * 60 * 1000,
    matchThreshold: 0.02,
    maxSamplesPerVisit: 24,
    storageKey: 'jm.visitorStats.v1',
};

/** Presence test — the same rule that drives the "step closer" overlay. */
export function isFacePresent(
    pose: FacePose,
    frameH: number,
    maxDistanceCm: number,
    minFaceHeightFraction: number,
): boolean {
    return (
        pose.distance <= maxDistanceCm ||
        (frameH > 0 && pose.faceHeight >= frameH * minFaceHeightFraction)
    );
}

interface TrackedFace {
    signature: Float32Array;
    lastSeenAt: number;
}

export class VisitorCounter {
    private readonly opts: Required<VisitorCounterOptions>;

    private day: DayStats;
    private tracked: TrackedFace[] = [];

    // Running visit
    private visitStartedAt = 0;
    private lastPresentAt = 0;
    private counted = false;
    private samples: Float32Array[] = [];

    private visitListeners: ((visit: VisitRecord) => void)[] = [];
    private dayListeners: ((day: DayStats, reason: 'rollover') => void)[] = [];

    constructor(options: VisitorCounterOptions) {
        this.opts = { ...DEFAULTS, ...options };
        this.day = this.loadDay();
    }

    /** Called once per frame with the poses for this frame. */
    update(poses: FacePose[], frameH: number, now = Date.now()): void {
        this.rollOverIfNeeded(now);

        const present = poses.find((p) =>
            isFacePresent(
                p,
                frameH,
                this.opts.maxDistanceCm,
                this.opts.minFaceHeightFraction,
            ),
        );

        if (present) {
            if (this.visitStartedAt === 0) {
                this.visitStartedAt = now;
                this.samples = [];
                this.counted = false;
            }
            this.lastPresentAt = now;

            if (this.samples.length < this.opts.maxSamplesPerVisit) {
                const sig = computeFaceSignature(present);
                if (sig) this.samples.push(sig);
            }
            return;
        }

        if (this.visitStartedAt !== 0 && now - this.lastPresentAt > this.opts.absenceGapMs) {
            this.endVisit(now);
        }
    }

    /** Close the running visit, if any — e.g. when the page is being hidden. */
    flushVisit(now = Date.now()): void {
        if (this.visitStartedAt !== 0) this.endVisit(now);
    }

    onVisit(cb: (visit: VisitRecord) => void): void {
        this.visitListeners.push(cb);
    }

    /** Fires when the local day flips, with the completed day's final tally. */
    onDayRollover(cb: (day: DayStats, reason: 'rollover') => void): void {
        this.dayListeners.push(cb);
    }

    getDayStats(): DayStats {
        return { ...this.day };
    }

    getState(now = Date.now()): CounterState {
        return {
            present: this.visitStartedAt !== 0,
            currentDwellMs:
                this.visitStartedAt === 0 ? 0 : Math.max(0, now - this.visitStartedAt),
            samples: this.samples.length,
            tracked: this.tracked.length,
            day: this.getDayStats(),
        };
    }

    // -----------------------------------------------------------------------

    private endVisit(now: number): void {
        const startedAt = this.visitStartedAt;
        const endedAt = this.lastPresentAt;
        const durationMs = endedAt - startedAt;

        this.visitStartedAt = 0;
        const samples = this.samples;
        this.samples = [];

        // Too brief to be a visitor — someone crossing the frame.
        if (durationMs < this.opts.minPresenceMs || this.counted) return;
        this.counted = true;

        const signature = medianSignature(samples);
        const returning = signature ? this.matchAndTrack(signature, now) : false;

        this.day.visits += 1;
        this.day.totalDwellMs += durationMs;
        if (returning) this.day.returningVisits += 1;
        else this.day.uniqueFaces += 1;
        if (!this.day.firstVisitAt) this.day.firstVisitAt = new Date(startedAt).toISOString();
        this.day.lastVisitAt = new Date(endedAt).toISOString();
        this.saveDay();

        const visit: VisitRecord = {
            visitId: randomId(),
            date: this.day.date,
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date(endedAt).toISOString(),
            durationMs,
            returning,
            sequence: this.day.visits,
        };
        for (const cb of this.visitListeners) cb(visit);
    }

    /**
     * Compare against faces still inside the re-visit window. Returns true when
     * this is somebody we already counted; either way the face is (re)tracked.
     */
    private matchAndTrack(signature: Float32Array, now: number): boolean {
        const cutoff = now - this.opts.revisitWindowMs;
        this.tracked = this.tracked.filter((t) => t.lastSeenAt >= cutoff);

        let best: TrackedFace | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const t of this.tracked) {
            const d = signatureDistance(signature, t.signature);
            if (d < bestDist) {
                bestDist = d;
                best = t;
            }
        }

        if (best && bestDist <= this.opts.matchThreshold) {
            best.lastSeenAt = now;
            return true;
        }
        this.tracked.push({ signature, lastSeenAt: now });
        return false;
    }

    private rollOverIfNeeded(now: number): void {
        const today = localDateKey(now);
        if (today === this.day.date) return;

        const finished = this.day;
        this.day = emptyDay(today);
        this.tracked = [];
        this.saveDay();
        for (const cb of this.dayListeners) cb(finished, 'rollover');
    }

    private loadDay(): DayStats {
        const today = localDateKey(Date.now());
        try {
            const raw = localStorage.getItem(this.opts.storageKey);
            if (raw) {
                const parsed = JSON.parse(raw) as DayStats;
                if (parsed?.date === today) return { ...emptyDay(today), ...parsed };
            }
        } catch {
            // Private mode / cleared storage — start fresh.
        }
        return emptyDay(today);
    }

    private saveDay(): void {
        try {
            localStorage.setItem(this.opts.storageKey, JSON.stringify(this.day));
        } catch {
            // Storage unavailable — the tally simply won't survive a reload.
        }
    }
}

function emptyDay(date: string): DayStats {
    return {
        date,
        uniqueFaces: 0,
        visits: 0,
        returningVisits: 0,
        totalDwellMs: 0,
        firstVisitAt: null,
        lastVisitAt: null,
    };
}

/** YYYY-MM-DD in the kiosk's own timezone — shop days, not UTC days. */
export function localDateKey(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function randomId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
