import { randomId } from './visitor-counter.ts';

/**
 * Ships measurement events to the backend.
 *
 * The kiosk runs unattended on a shop's wifi, so nothing is fire-and-forget:
 * events are queued, mirrored into localStorage, batched, retried with
 * exponential backoff, and flushed again when the page is closed or reloaded.
 * With no endpoint configured the reporter is a no-op and the app runs exactly
 * as before — handy while the backend is still being built.
 */

export type StatsEvent =
    | ({ type: 'visit' } & Record<string, unknown>)
    | ({ type: 'daily' } & Record<string, unknown>);

interface QueuedEvent {
    eventId: string;
    queuedAt: string;
    payload: StatsEvent;
}

export interface ReporterOptions {
    /** Full URL of the collector endpoint. Empty disables sending. */
    endpoint: string;
    /** Optional bearer token sent as `Authorization: Bearer …`. */
    token?: string;
    /** Identifies this mirror to the backend. */
    kioskId: string;
    /** Max events per POST. */
    batchSize?: number;
    /** How often the queue is checked (ms). */
    flushIntervalMs?: number;
    /**
     * How long a send waits for its companions before going out (ms).
     *
     * A finished visit queues two events at once — the visit and the updated
     * day tally. Flushing on the first would leave the second behind until the
     * next interval, so the dashboard and the visit list would disagree for
     * fifteen seconds. Collecting them into one request keeps them atomic.
     */
    sendDebounceMs?: number;
    /** Hard cap on the queue; oldest events are dropped past it. */
    maxQueue?: number;
    /** localStorage key for the durable queue. */
    storageKey?: string;
}

export interface ReporterState {
    enabled: boolean;
    endpoint: string;
    queued: number;
    lastFlushAt: number | null;
    lastError: string | null;
    retryDelayMs: number;
}

const DEFAULTS = {
    batchSize: 50,
    flushIntervalMs: 15_000,
    sendDebounceMs: 250,
    maxQueue: 500,
    storageKey: 'jm.statsQueue.v1',
};

const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

/**
 * Statuses that mean "this payload will never be accepted" — the batch is
 * dropped so one bad event cannot wedge the queue. Auth and routing errors
 * (401/403/404) are kept: those are config mistakes that get fixed, and the
 * data is still worth having afterwards.
 */
const PERMANENT_STATUSES = new Set([400, 413, 422]);

export class StatsReporter {
    private readonly opts: Required<ReporterOptions>;
    private queue: QueuedEvent[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private sendTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing = false;
    private nextAttemptAt = 0;
    private retryDelayMs = BASE_RETRY_MS;
    private lastFlushAt: number | null = null;
    private lastError: string | null = null;

    constructor(options: ReporterOptions) {
        this.opts = { token: '', ...DEFAULTS, ...options };
        this.queue = this.load();

        if (!this.enabled) return;

        this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);

        // Last chance to get events out before the tab goes away.
        const onLeave = () => void this.flush({ force: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') onLeave();
        });
        window.addEventListener('pagehide', onLeave);
    }

    get enabled(): boolean {
        return this.opts.endpoint.length > 0;
    }

    /** Queue an event and try to send it shortly after. */
    send(payload: StatsEvent): void {
        if (!this.enabled) {
            if (import.meta.env.DEV) console.info('[stats] (no endpoint)', payload);
            return;
        }
        this.queue.push({
            eventId: randomId(),
            queuedAt: new Date().toISOString(),
            payload,
        });
        if (this.queue.length > this.opts.maxQueue) {
            this.queue.splice(0, this.queue.length - this.opts.maxQueue);
        }
        this.persist();
        this.flushSoon();
    }

    /**
     * Flush shortly, once. Events queued in the same moment then travel in one
     * request instead of the first one leaving alone and the rest waiting for
     * the next interval.
     */
    private flushSoon(): void {
        if (this.sendTimer !== null) return;

        this.sendTimer = setTimeout(() => {
            this.sendTimer = null;
            void this.flush();
        }, this.opts.sendDebounceMs);
    }

    async flush(opts: { force?: boolean } = {}): Promise<void> {
        if (!this.enabled || this.flushing || this.queue.length === 0) return;
        const now = Date.now();
        if (!opts.force && now < this.nextAttemptAt) return;

        this.flushing = true;
        const batch = this.queue.slice(0, this.opts.batchSize);

        try {
            const res = await fetch(this.opts.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.opts.token
                        ? { Authorization: `Bearer ${this.opts.token}` }
                        : {}),
                },
                body: JSON.stringify({
                    kioskId: this.opts.kioskId,
                    sentAt: new Date().toISOString(),
                    events: batch.map((e) => ({
                        eventId: e.eventId,
                        queuedAt: e.queuedAt,
                        ...e.payload,
                    })),
                }),
                // Survives the page being torn down mid-request.
                keepalive: true,
            });

            if (!res.ok) {
                if (PERMANENT_STATUSES.has(res.status)) {
                    console.error(
                        `[stats] dropping ${batch.length} event(s), backend said ${res.status}`,
                    );
                    this.drop(batch.length);
                    this.lastError = `dropped on HTTP ${res.status}`;
                    return;
                }
                throw new Error(`HTTP ${res.status}`);
            }

            this.drop(batch.length);
            this.lastFlushAt = Date.now();
            this.lastError = null;
            this.retryDelayMs = BASE_RETRY_MS;
            this.nextAttemptAt = 0;
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            this.nextAttemptAt = Date.now() + this.retryDelayMs;
            this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
        } finally {
            this.flushing = false;
        }
    }

    /**
     * Throws away everything still queued.
     *
     * Only for the debug reset: those events describe visits that are being
     * wiped anyway, so delivering them afterwards would put the old numbers
     * straight back.
     */
    clearQueue(): void {
        this.queue = [];
        this.persist();
        this.nextAttemptAt = 0;
        this.retryDelayMs = BASE_RETRY_MS;
        this.lastError = null;
    }

    getState(): ReporterState {
        return {
            enabled: this.enabled,
            endpoint: this.opts.endpoint,
            queued: this.queue.length,
            lastFlushAt: this.lastFlushAt,
            lastError: this.lastError,
            retryDelayMs: this.retryDelayMs,
        };
    }

    dispose(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        if (this.sendTimer !== null) clearTimeout(this.sendTimer);
        this.sendTimer = null;
    }

    // -----------------------------------------------------------------------

    private drop(count: number): void {
        this.queue.splice(0, count);
        this.persist();
    }

    private persist(): void {
        try {
            localStorage.setItem(this.opts.storageKey, JSON.stringify(this.queue));
        } catch {
            // Storage unavailable — events live in memory for this session only.
        }
    }

    private load(): QueuedEvent[] {
        try {
            const raw = localStorage.getItem(this.opts.storageKey);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? (parsed as QueuedEvent[]) : [];
        } catch {
            return [];
        }
    }
}
