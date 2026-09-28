import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createMeasurement } from '../src/measurement.ts';
import type { FacePose } from '../src/types.ts';

/**
 * Checks what actually leaves the kiosk.
 *
 * The visit list and the dashboard read different tables — kiosk_visits and
 * kiosk_days — so they only agree if the kiosk pushes both at the same moment.
 * It used to push the tally on a five minute timer, which left the two screens
 * contradicting each other with nothing on screen saying so.
 */

const FRAME_H = 1080;
const ABSENCE_GAP_MS = 8000;

interface SentEvent {
    type: string;
    [key: string]: unknown;
}

test('a finished visit pushes the visit AND the day tally', async (t) => {
    const { measurement, sent } = harness(t);

    runVisit(measurement, pose(1), at(0));
    await settle();

    const types = sent().map((e) => e.type);
    assert.deepEqual(types, ['visit', 'daily']);

    const daily = sent().find((e) => e.type === 'daily')!;
    assert.equal(daily.visits, 1);
    assert.equal(daily.uniqueFaces, 1);
});

test('a second visit pushes the running total, not just the delta', async (t) => {
    const { measurement, sent } = harness(t);

    runVisit(measurement, pose(1), at(0));
    runVisit(measurement, pose(2), at(1));
    await settle();

    const dailies = sent().filter((e) => e.type === 'daily');
    assert.equal(dailies.length, 2);
    assert.equal(dailies[0].visits, 1);
    assert.equal(dailies[1].visits, 2);
    assert.equal(dailies[1].uniqueFaces, 2);
});

test('a visit that could not be described also refreshes the dashboard', async (t) => {
    // Without this the "niet herkenbaar" count would lag behind the visit list
    // exactly the way the totals used to.
    const { measurement, sent } = harness(t);

    runVisit(measurement, pose(1, { yawDeg: 40 }), at(0));
    await settle();

    const daily = sent().find((e) => e.type === 'daily')!;
    assert.equal(daily.unknownFaces, 1);
    assert.equal(daily.uniqueFaces, 0);
    assert.equal(daily.visits, 1);
});

test('a quiet day sends nothing at all', async (t) => {
    // The five minute timer is a heartbeat now, not a cadence; it must not
    // generate traffic when nobody has stood at the mirror.
    const { measurement, sent } = harness(t);

    for (let i = 0; i < 40; i++) {
        measurement.counter.update([], FRAME_H, at(0) + i * 1000);
    }
    await settle();

    assert.deepEqual(sent(), []);
});

test('someone walking past is not reported', async (t) => {
    const { measurement, sent } = harness(t);

    // Under minPresenceMs, so it never becomes a visit.
    runVisit(measurement, pose(1), at(0), 800);
    await settle();

    assert.deepEqual(sent(), []);
});

// ---------------------------------------------------------------------------

/**
 * A measurement wired to a fake collector, with the events it posted.
 *
 * Takes the test context so the reporter's flush interval is always released —
 * it keeps the node process alive otherwise and the run never finishes.
 */
function harness(t: { after: (fn: () => void) => void }): {
    measurement: ReturnType<typeof createMeasurement>;
    sent: () => SentEvent[];
} {
    installLocalStorage();

    const posted: SentEvent[] = [];

    globalThis.fetch = (async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { events: SentEvent[] };
        posted.push(...body.events);
        return { ok: true, status: 202 };
    }) as unknown as typeof fetch;

    const measurement = createMeasurement({
        maxDistanceCm: 95,
        minFaceHeightFraction: 0.22,
        env: {
            VITE_STATS_ENDPOINT: 'http://collector.test/kiosk/stats',
            VITE_KIOSK_ID: 'jm-optiek-test',
        },
    });

    t.after(() => measurement.dispose());

    return { measurement, sent: () => posted };
}

/**
 * The reporter batches everything queued in the same moment and then flushes
 * once (sendDebounceMs). Wait past that, plus a little for the request itself.
 */
async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

/**
 * Drives the counter directly rather than measurement.update, because the
 * latter reads the clock itself and a visit would take real seconds to close.
 */
function runVisit(
    measurement: ReturnType<typeof createMeasurement>,
    facePose: FacePose,
    startAt: number,
    durationMs = 3000,
): void {
    for (let t = 0; t <= durationMs; t += 200) {
        measurement.counter.update([facePose], FRAME_H, startAt + t);
    }
    measurement.counter.update([], FRAME_H, startAt + durationMs + ABSENCE_GAP_MS + 1);
}

/** Minutes past 10:00 today — staying inside one local day avoids rollover. */
function at(minutes: number): number {
    const base = new Date();
    base.setHours(10, 0, 0, 0);
    return base.getTime() + minutes * 60_000;
}

function pose(person: number, opts: { yawDeg?: number } = {}): FacePose {
    const quaternion = new THREE.Quaternion();
    if (opts.yawDeg) {
        quaternion.setFromEuler(new THREE.Euler(0, (opts.yawDeg * Math.PI) / 180, 0, 'YXZ'));
    }

    const rnd = mulberry32(person * 7919 + 13);

    return {
        distance: 60,
        faceHeight: FRAME_H * 0.4,
        quaternion,
        allLandmarks: Array.from({ length: 468 }, () => ({
            x: rnd() * 200,
            y: rnd() * 260,
            z: rnd() * 60,
        })),
    } as unknown as FacePose;
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function installLocalStorage(): void {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    };
}

/** The reporter registers page lifecycle listeners; node has no document. */
(globalThis as Record<string, unknown>).document ??= {
    addEventListener: () => {},
    visibilityState: 'visible',
};
(globalThis as Record<string, unknown>).window ??= { addEventListener: () => {} };
