import * as THREE from 'three';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { FaceLandmark, type FacePose } from './types.ts';

// ---- Triangle extraction (computed once, lazily) ----

let cachedTriangles: Uint16Array | null = null;

/**
 * Build triangle indices from MediaPipe's tesselation edges.
 * Edges define a planar graph; triangles are 3-cliques (a-b, b-c, c-a).
 */
function buildTriangles(): Uint16Array {
    if (cachedTriangles) return cachedTriangles;

    const edges = FaceLandmarker.FACE_LANDMARKS_TESSELATION;

    // Build adjacency: for each vertex, the set of neighbors
    const adj = new Map<number, Set<number>>();
    const addEdge = (a: number, b: number) => {
        if (!adj.has(a)) adj.set(a, new Set());
        adj.get(a)!.add(b);
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(b)!.add(a);
    };
    for (const e of edges) addEdge(e.start, e.end);

    // Collect face oval vertices, then selectively expand exclusion:
    // - Left/right sides get 2-ring exclusion (prevents glasses arm clipping)
    // - Forehead & chin get 1-ring only (keeps occluder tall enough)
    const ovalLoop = orderedLoop(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
    const ovalVerts = new Set(ovalLoop);
    const ovalLen = ovalLoop.length;

    // Find forehead (top) and chin (bottom) positions in the oval loop
    const foreheadIdx = ovalLoop.indexOf(FaceLandmark.FOREHEAD);
    const chinIdx = ovalLoop.indexOf(FaceLandmark.CHIN);

    // Mark top ~40% around forehead and bottom ~30% around chin as non-expandable
    const noExpandVerts = new Set<number>();
    if (foreheadIdx >= 0) {
        const topCount = Math.round(ovalLen * 0.4);
        for (let k = -Math.floor(topCount / 2); k <= Math.floor(topCount / 2); k++) {
            noExpandVerts.add(ovalLoop[((foreheadIdx + k) % ovalLen + ovalLen) % ovalLen]);
        }
    }
    if (chinIdx >= 0) {
        const bottomCount = Math.round(ovalLen * 0.3);
        for (let k = -Math.floor(bottomCount / 2); k <= Math.floor(bottomCount / 2); k++) {
            noExpandVerts.add(ovalLoop[((chinIdx + k) % ovalLen + ovalLen) % ovalLen]);
        }
    }

    // Expand by one ring only for side oval vertices (not forehead/chin)
    const excludedVerts = new Set(ovalVerts);
    for (const v of ovalVerts) {
        if (noExpandVerts.has(v)) continue;
        const neighbors = adj.get(v);
        if (neighbors) {
            for (const n of neighbors) excludedVerts.add(n);
        }
    }

    // Find all 3-cliques: for each edge (a, b), any shared neighbor c forms a triangle
    const triangleSet = new Set<string>();
    const triangles: number[] = [];

    for (const e of edges) {
        const a = e.start;
        const b = e.end;
        const neighborsA = adj.get(a);
        const neighborsB = adj.get(b);
        if (!neighborsA || !neighborsB) continue;

        for (const c of neighborsA) {
            if (c !== b && neighborsB.has(c)) {
                // Skip triangles touching the exclusion border
                if (excludedVerts.has(a) || excludedVerts.has(b) || excludedVerts.has(c)) continue;
                const tri = [a, b, c].sort((x, y) => x - y);
                const key = `${tri[0]},${tri[1]},${tri[2]}`;
                if (!triangleSet.has(key)) {
                    triangleSet.add(key);
                    triangles.push(tri[0], tri[1], tri[2]);
                }
            }
        }
    }

    // Fill eye and mouth holes with fan triangulation
    const loops = [
        FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
        FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
        FaceLandmarker.FACE_LANDMARKS_LIPS,
    ];
    for (const connections of loops) {
        const ordered = orderedLoop(connections);
        if (ordered.length >= 3) {
            const anchor = ordered[0];
            for (let j = 1; j < ordered.length - 1; j++) {
                triangles.push(anchor, ordered[j], ordered[j + 1]);
            }
        }
    }

    cachedTriangles = new Uint16Array(triangles);
    return cachedTriangles;
}

/** Extract an ordered vertex loop from a set of edges. */
function orderedLoop(connections: { start: number; end: number }[]): number[] {
    // Build adjacency list (each vertex has exactly 2 neighbors in a closed loop)
    const adj = new Map<number, number[]>();
    for (const c of connections) {
        if (!adj.has(c.start)) adj.set(c.start, []);
        adj.get(c.start)!.push(c.end);
        if (!adj.has(c.end)) adj.set(c.end, []);
        adj.get(c.end)!.push(c.start);
    }

    const loop: number[] = [];
    const first = connections[0].start;
    let prev = -1;
    let cur = first;
    do {
        loop.push(cur);
        const neighbors = adj.get(cur)!;
        // Pick the neighbor we haven't come from
        const next = neighbors.find((n) => n !== prev) ?? neighbors[0];
        prev = cur;
        cur = next;
    } while (cur !== first && loop.length < adj.size + 1);

    return loop;
}

// ---- Materials ----

const occluderMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    side: THREE.DoubleSide,
});

const debugMat = new THREE.MeshBasicMaterial({
    color: 0x9900ff,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: true,
});

// ---- Depth bias: push the occluder slightly behind the glasses ----
const DEPTH_BIAS = 2;

// ---- Front-side cutoff: disable up to 30% of the camera-facing side ----
const FRONT_CUTOFF = 0.3;

/**
 * Dynamic face occluder built from 468 MediaPipe face landmarks.
 * Vertices ARE the tracked face points — guarantees pixel-perfect alignment.
 */
export class FaceOccluder {
    private meshes: THREE.Mesh[] = [];
    private showDebug = false;

    /** Ensure we have enough meshes for the number of faces. */
    private ensureMeshes(count: number, scene: THREE.Scene): void {
        while (this.meshes.length < count) {
            const triangles = buildTriangles();
            const geo = new THREE.BufferGeometry();
            // 468 vertices × 3 components
            geo.setAttribute(
                'position',
                new THREE.BufferAttribute(new Float32Array(468 * 3), 3),
            );
            geo.setIndex(new THREE.BufferAttribute(triangles, 1));

            const mesh = new THREE.Mesh(
                geo,
                this.showDebug ? debugMat : occluderMat,
            );
            mesh.renderOrder = 0;
            mesh.frustumCulled = false;
            scene.add(mesh);
            this.meshes.push(mesh);
        }
    }

    /**
     * Update occluder meshes from tracked face poses.
     * Call once per frame from the render loop.
     */
    update(
        poses: FacePose[],
        canvasW: number,
        canvasH: number,
        scene: THREE.Scene,
    ): void {
        this.ensureMeshes(poses.length, scene);

        const halfW = canvasW / 2;
        const halfH = canvasH / 2;

        for (let i = 0; i < this.meshes.length; i++) {
            const mesh = this.meshes[i];
            if (i >= poses.length) {
                mesh.visible = false;
                continue;
            }

            mesh.visible = true;
            const lm = poses[i].allLandmarks;
            if (!lm || lm.length === 0) {
                mesh.visible = false;
                continue;
            }

            // Use nose bridge (landmark 6) Z as the reference depth
            const noseBridgeZ = lm[6].z;

            // Determine head yaw from temple-to-nose asymmetry
            const noseX = lm[FaceLandmark.NOSE_BRIDGE].x;
            const leftTempleX = lm[FaceLandmark.LEFT_TEMPLE].x;   // YOUR left → screen right
            const rightTempleX = lm[FaceLandmark.RIGHT_TEMPLE].x; // YOUR right → screen left
            const distRight = leftTempleX - noseX;   // nose to screen-right edge
            const distLeft = noseX - rightTempleX;    // nose to screen-left edge
            const totalDist = distRight + distLeft;

            // yaw > 0 → right side (screen) is compressed/front-facing
            // yaw < 0 → left side (screen) is compressed/front-facing
            const yaw = totalDist > 0 ? (distLeft - distRight) / totalDist : 0;
            const yawMag = Math.abs(yaw);

            // Scale cutoff with yaw: 0% when straight, up to 30% when turned
            const cutoffFrac = Math.min(yawMag * 3, 1) * FRONT_CUTOFF;

            const faceMinX = Math.min(leftTempleX, rightTempleX);
            const faceMaxX = Math.max(leftTempleX, rightTempleX);
            const faceW = faceMaxX - faceMinX;

            const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            const arr = posAttr.array as Float32Array;

            for (let v = 0; v < lm.length; v++) {
                const idx = v * 3;
                const vx = lm[v].x;

                // Check if vertex is on the front-facing side and should be disabled
                let disable = false;
                if (faceW > 0 && yawMag > 0.05) {
                    const frac = (vx - faceMinX) / faceW; // 0 = left edge, 1 = right edge
                    if (yaw > 0) {
                        // Right side is front → disable vertices near right edge
                        disable = frac > (1 - cutoffFrac);
                    } else {
                        // Left side is front → disable vertices near left edge
                        disable = frac < cutoffFrac;
                    }
                }

                arr[idx] = vx - halfW;
                arr[idx + 1] = -(lm[v].y - halfH);
                arr[idx + 2] = disable ? -1000 : -(lm[v].z - noseBridgeZ) - DEPTH_BIAS;
            }

            posAttr.needsUpdate = true;
            mesh.geometry.computeBoundingSphere();
        }
    }

    /** Toggle debug visualisation (semi-transparent purple mesh). */
    setShowDebug(visible: boolean): void {
        this.showDebug = visible;
        const mat = visible ? debugMat : occluderMat;
        for (const mesh of this.meshes) {
            mesh.material = mat;
        }
    }
}
