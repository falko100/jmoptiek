import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { VisitorCounter } from '../src/visitor-counter.ts';
import { computeFaceSignature, signatureDistance } from '../src/face-signature.ts';
import type { FacePose } from '../src/types.ts';

/**
 * Checks the counting rule behind "unieke gezichten".
 *
 * Scope: this tests when the counter decides two visits are the same person —
 * the windows, the sliding, the thresholds. It does NOT test how well the
 * descriptor tells real faces apart; synthetic landmarks say nothing about
 * that, and the match debug panel (key "m") is the instrument for it.
 */

const FRAME_H = 1080;
const ABSENCE_GAP_MS = 2500;
const TEN_MINUTES = 10 * 60 * 1000;

// The counter persists the day tally; give every counter its own key so tests
// cannot leak into one another.
let keySeq = 0;
installLocalStorage();

test('the re-visit window is the 10 minutes the dashboard claims', () => {
    assert.equal(counter().getRevisitWindowMs(), TEN_MINUTES);
});

test('somebody walking past is not a visit', () => {
    const c = counter();
    // Under minPresenceMs (1200 ms).
    runVisit(c, pose(1), at(10), 800);

    const day = c.getDayStats();
    assert.equal(day.visits, 0);
    assert.equal(day.uniqueFaces, 0);
});

test('one person standing at the mirror is one unique face', () => {
    const c = counter();
    runVisit(c, pose(1), at(10));

    const day = c.getDayStats();
    assert.equal(day.visits, 1);
    assert.equal(day.uniqueFaces, 1);
    assert.equal(day.returningVisits, 0);
});

test('two different people are two unique faces', () => {
    const c = counter();
    runVisit(c, pose(1), at(10));
    runVisit(c, pose(2), at(11));

    const day = c.getDayStats();
    assert.equal(day.visits, 2);
    assert.equal(day.uniqueFaces, 2);
});

test('coming back inside the window does not add a unique face', () => {
    const c = counter();
    runVisit(c, pose(1), at(10));
    runVisit(c, pose(1), at(15));

    const day = c.getDayStats();
    assert.equal(day.visits, 2);
    assert.equal(day.uniqueFaces, 1);
    assert.equal(day.returningVisits, 1);
});

test('the same customer in the morning and afternoon counts twice', () => {
    // This is the claim printed under the dashboard chart.
    const c = counter();
    runVisit(c, pose(1), at(0));
    runVisit(c, pose(1), at(4 * 60)); // four hours later

    const day = c.getDayStats();
    assert.equal(day.visits, 2);
    assert.equal(day.uniqueFaces, 2);
    assert.equal(day.returningVisits, 0);
});

test('the window slides, so a chain of returns stays one face for hours', () => {
    // Worth knowing: "de-duplicated within 10 minutes" is measured from the
    // LAST sighting, not the first. Somebody drifting back every few minutes
    // keeps their entry alive and stays a single unique face indefinitely.
    const c = counter();
    // Seven visits spread over 54 minutes, each 9 minutes after the last.
    for (let minute = 0; minute <= 54; minute += 9) {
        runVisit(c, pose(1), at(minute));
    }

    const day = c.getDayStats();
    assert.equal(day.visits, 7);
    // Nearly an hour apart end to end, yet still a single unique face.
    assert.equal(day.uniqueFaces, 1);
    assert.equal(day.returningVisits, 6);
});

test('a return just past the window is a new unique face', () => {
    const c = counter();
    runVisit(c, pose(1), at(0));
    runVisit(c, pose(1), at(11));

    assert.equal(c.getDayStats().uniqueFaces, 2);
});

test('a turned head is never sampled, so the visit cannot be matched', () => {
    // Outside the frontal gate no signature is built at all, and an unmatched
    // visit always counts as a new face — a mirror people glance at sideways
    // over-counts by construction.
    const c = counter();
    runVisit(c, pose(1), at(10));
    runVisit(c, pose(1, { yawDeg: 40 }), at(12));

    assert.equal(c.getDayStats().uniqueFaces, 2);
});

test('the fixture itself separates people, so the tests above mean something', () => {
    const same = signatureDistance(signature(pose(1)), signature(pose(1)));
    const other = signatureDistance(signature(pose(1)), signature(pose(2)));

    assert.equal(same, 0);
    assert.ok(other > 0.1, `verschillende personen scoorden ${other}`);
});

// ---------------------------------------------------------------------------

function counter(): VisitorCounter {
    return new VisitorCounter({
        maxDistanceCm: 95,
        minFaceHeightFraction: 0.22,
        storageKey: `test.visitorStats.${keySeq++}`,
    });
}

/** Feeds presence for `durationMs`, then enough absence to close the visit. */
function runVisit(
    counter: VisitorCounter,
    facePose: FacePose,
    startAt: number,
    durationMs = 3000,
): void {
    for (let t = 0; t <= durationMs; t += 200) {
        counter.update([facePose], FRAME_H, startAt + t);
    }
    counter.update([], FRAME_H, startAt + durationMs + ABSENCE_GAP_MS + 1);
}

/** Minutes past 10:00 today — staying inside one local day avoids rollover. */
function at(minutes: number): number {
    const base = new Date();
    base.setHours(10, 0, 0, 0);
    return base.getTime() + minutes * 60_000;
}

/** Only the fields the counter actually reads. */
function pose(person: number, opts: { yawDeg?: number } = {}): FacePose {
    const quaternion = new THREE.Quaternion();
    if (opts.yawDeg) {
        quaternion.setFromEuler(
            new THREE.Euler(0, (opts.yawDeg * Math.PI) / 180, 0, 'YXZ'),
        );
    }

    return {
        distance: 60,
        faceHeight: FRAME_H * 0.4,
        quaternion,
        allLandmarks: landmarks(person),
    } as unknown as FacePose;
}

/** Deterministic landmark cloud; a different person is a different geometry. */
function landmarks(person: number): { x: number; y: number; z: number }[] {
    const rnd = mulberry32(person * 7919 + 13);
    return Array.from({ length: 468 }, () => ({
        x: rnd() * 200,
        y: rnd() * 260,
        z: rnd() * 60,
    }));
}

function signature(facePose: FacePose): Float32Array {
    const sig = computeFaceSignature(facePose);
    assert.ok(sig, 'fixture leverde geen signature op');
    return sig;
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

/** The counter reads localStorage; node has none. */
function installLocalStorage(): void {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    };
}
