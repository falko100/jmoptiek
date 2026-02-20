import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
    EffectComposer,
    EffectPass,
    RenderPass,
    BloomEffect,
    SMAAEffect,
    SMAAPreset,
    ToneMappingEffect,
    ToneMappingMode,
} from 'postprocessing';
import type { FacePose } from './types.ts';

/**
 * Internal render resolution multiplier.
 * Renders at 2x then the CSS scales down, giving sharper details.
 */
const SUPERSAMPLE = 2;

export interface GlassesParams {
    scale: number;
    offsetY: number;
    depth: number;
    baseRotX: number;
    baseRotY: number;
    baseRotZ: number;
    occluderZ: number;
    /** Clip the glasses at this depth behind the face (fraction of eye distance). 0 = no clipping. */
    clipDepth: number;
}

export const DEFAULT_PARAMS: GlassesParams = {
    scale: 1.80,
    offsetY: 0.02,
    depth: -0.45,
    baseRotX: -4,
    baseRotY: -2,
    baseRotZ: 0,
    occluderZ: 0,
    clipDepth: 0.55,
};

// ---- Occluder material (invisible, depth-only) ----

const occluderMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
});

// ---- Transition config ----

const TRANSITION_DURATION = 400; // ms

/** easeInOutCubic */
function ease(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---- Preloaded model entry ----

interface PreloadedModel {
    url: string;
    template: THREE.Object3D;
    pivot: THREE.Group;
    width: number;
}

interface Transition {
    fromIndex: number;
    toIndex: number;
    /** 1 = slide right (next), -1 = slide left (prev) */
    direction: number;
    startTime: number;
    fromClones: THREE.Object3D[];
    toClones: THREE.Object3D[];
}

/**
 * Three.js overlay that renders 3D glasses models for each detected face.
 * All models are preloaded for instant switching with slide animations.
 */
export class GlassesRenderer {
    private renderer: THREE.WebGLRenderer;
    private composer: EffectComposer;
    private scene: THREE.Scene;
    private camera: THREE.OrthographicCamera;

    // ---- Toggleable effect passes ----
    private bloomPass!: EffectPass;
    private toneMappingPass!: EffectPass;
    private smaaPass!: EffectPass;
    private envMap!: THREE.Texture;
    private ambientLight!: THREE.AmbientLight;
    private keyLight!: THREE.DirectionalLight;
    private fillLight!: THREE.DirectionalLight;

    // ---- Preloaded models ----
    private models: PreloadedModel[] = [];
    private currentModelIndex = -1;

    // ---- Active clones for current model ----
    private activeClones: THREE.Object3D[] = [];

    // ---- Transition state ----
    private transition: Transition | null = null;

    // ---- Occluder ----
    private occluderTemplate: THREE.Object3D | null = null;
    private occluderBaseHeight = 1;
    private occluderOriginalMaterials = new Map<string, THREE.Material | THREE.Material[]>();
    private activeOccluders: THREE.Object3D[] = [];
    private _showOccluder = false;

    /** Clipping plane used to cut off the back of the glasses */
    private clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    params: GlassesParams = { ...DEFAULT_PARAMS };

    private canvasW = 1;
    private canvasH = 1;

    constructor(canvas: HTMLCanvasElement) {
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            alpha: true,
            antialias: false,
            powerPreference: 'high-performance',
        });
        // Don't use devicePixelRatio — we handle supersampling ourselves
        this.renderer.setPixelRatio(1);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.sortObjects = true;
        this.renderer.localClippingEnabled = true;

        // ---- model-viewer style rendering ----
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 0.25;

        this.scene = new THREE.Scene();

        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
        this.camera.position.set(0, 0, 500);
        this.camera.lookAt(0, 0, 0);

        // ---- IBL: neutral studio environment (same approach as model-viewer) ----
        const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        pmremGenerator.compileEquirectangularShader();
        const roomEnv = new RoomEnvironment();
        const envMap = pmremGenerator.fromScene(roomEnv, 0.04).texture;
        pmremGenerator.dispose();

        // Use as reflection/lighting environment, NOT as visible background
        this.envMap = envMap;
        this.scene.environment = envMap;
        this.scene.environmentIntensity = 1.25;

        // Subtle fill light to complement the IBL
        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(this.ambientLight);

        // Soft key light from above-front
        this.keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
        this.keyLight.position.set(0, 150, 300);
        this.scene.add(this.keyLight);

        // Fill light from below to soften shadows under glasses
        this.fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        this.fillLight.position.set(0, -100, 200);
        this.scene.add(this.fillLight);

        // ---- Post-processing pipeline ----
        this.composer = new EffectComposer(this.renderer, {
            frameBufferType: THREE.HalfFloatType,
            alpha: true,
            multisampling: 4, // 4x MSAA on the framebuffer
        });

        const renderPass = new RenderPass(this.scene, this.camera);
        renderPass.clearPass.enabled = true;
        this.composer.addPass(renderPass);

        // Each effect in its own pass so they can be toggled independently

        // Tone mapping (ACES filmic — same as model-viewer)
        this.toneMappingPass = new EffectPass(
            this.camera,
            new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
        );
        this.composer.addPass(this.toneMappingPass);

        // Bloom — off by default (can look weird on some models)
        this.bloomPass = new EffectPass(
            this.camera,
            new BloomEffect({
                intensity: 0.5,
                luminanceThreshold: 0.8,
                luminanceSmoothing: 0.2,
                mipmapBlur: true,
            }),
        );
        this.bloomPass.enabled = false;
        this.composer.addPass(this.bloomPass);

        // SMAA anti-aliasing
        this.smaaPass = new EffectPass(
            this.camera,
            new SMAAEffect({ preset: SMAAPreset.HIGH }),
        );
        this.composer.addPass(this.smaaPass);
    }

    // ==== Effect toggles ====

    setBloom(on: boolean): void {
        this.bloomPass.enabled = on;
    }

    setToneMapping(on: boolean): void {
        this.toneMappingPass.enabled = on;
    }

    setSMAA(on: boolean): void {
        this.smaaPass.enabled = on;
    }

    setEnvironmentMap(on: boolean): void {
        this.scene.environment = on ? this.envMap : null;
    }

    setEnvironmentIntensity(value: number): void {
        this.scene.environmentIntensity = value;
    }

    /** Scale all direct lights. 1.0 = default intensities. */
    setLightIntensity(factor: number): void {
        this.ambientLight.intensity = 0.4 * factor;
        this.keyLight.intensity = 0.8 * factor;
        this.fillLight.intensity = 0.3 * factor;
    }

    setExposure(value: number): void {
        this.renderer.toneMappingExposure = value;
    }

    // ==== Occluder ====

    get showOccluder(): boolean {
        return this._showOccluder;
    }

    setShowOccluder(visible: boolean): void {
        this._showOccluder = visible;
        const apply = (obj: THREE.Object3D) => {
            obj.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    if (visible) {
                        const orig = this.occluderOriginalMaterials.get(child.name);
                        if (orig) child.material = orig;
                    } else {
                        child.material = occluderMaterial;
                    }
                }
            });
        };
        for (const occ of this.activeOccluders) apply(occ);
        if (this.occluderTemplate) apply(this.occluderTemplate);
    }

    async loadOccluder(url: string): Promise<void> {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        const model = gltf.scene;

        const box = new THREE.Box3().setFromObject(model);
        const center = new THREE.Vector3();
        box.getCenter(center);
        model.position.sub(center);

        const size = new THREE.Vector3();
        box.getSize(size);
        this.occluderBaseHeight = size.y;

        model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                this.occluderOriginalMaterials.set(child.name, child.material);
                child.material = occluderMaterial;
                child.renderOrder = 0;
            }
        });

        const wrapper = new THREE.Group();
        wrapper.add(model);
        wrapper.visible = false;
        wrapper.renderOrder = 0;
        this.scene.add(wrapper);
        this.occluderTemplate = wrapper;
    }

    // ==== Model preloading ====

    /** Preload all glasses models. Call once at startup. */
    async preloadModels(urls: string[]): Promise<void> {
        const loader = new GLTFLoader();

        const promises = urls.map(async (url) => {
            const gltf = await loader.loadAsync(url);
            const model = gltf.scene;

            // Strip junk
            const toRemove: THREE.Object3D[] = [];
            model.traverse((child) => {
                if (
                    child instanceof THREE.Points ||
                    child instanceof THREE.Sprite ||
                    child instanceof THREE.Line ||
                    child instanceof THREE.LineSegments
                ) {
                    toRemove.push(child);
                    return;
                }
                if (child instanceof THREE.Mesh) {
                    const geo = child.geometry;
                    const vtxCount = geo.getAttribute('position')?.count ?? 0;
                    if (vtxCount > 0 && vtxCount <= 128) {
                        const meshMat = Array.isArray(child.material) ? child.material[0] : child.material;
                        const isPlain =
                            meshMat instanceof THREE.MeshBasicMaterial ||
                            (meshMat instanceof THREE.MeshStandardMaterial &&
                                !meshMat.map &&
                                !meshMat.normalMap &&
                                meshMat.roughness >= 0.9);
                        if (isPlain) toRemove.push(child);
                    }
                }
            });
            for (const obj of toRemove) obj.removeFromParent();

            // Centre
            const box = new THREE.Box3().setFromObject(model);
            const ctr = new THREE.Vector3();
            box.getCenter(ctr);
            model.position.sub(ctr);

            // Pivot for base rotation
            const pivot = new THREE.Group();
            pivot.add(model);
            const deg = Math.PI / 180;
            pivot.rotation.set(
                this.params.baseRotX * deg,
                this.params.baseRotY * deg,
                this.params.baseRotZ * deg,
            );

            // Measure width
            pivot.updateMatrixWorld(true);
            const rotatedBox = new THREE.Box3().setFromObject(pivot);
            const sz = new THREE.Vector3();
            rotatedBox.getSize(sz);

            // Wrapper
            const wrapper = new THREE.Group();
            wrapper.add(pivot);
            wrapper.visible = false;
            wrapper.renderOrder = 1;
            const clipPlaneRef = this.clipPlane;
            wrapper.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.renderOrder = 1;
                    // Apply clipping plane to every material
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    for (const mat of mats) {
                        mat.clippingPlanes = [clipPlaneRef];
                        mat.clipShadows = true;
                    }
                }
            });
            this.scene.add(wrapper);

            return { url, template: wrapper, pivot, width: sz.x } as PreloadedModel;
        });

        this.models = await Promise.all(promises);
    }

    /** Get the number of preloaded models. */
    get modelCount(): number {
        return this.models.length;
    }

    /**
     * Switch to a model by index with an animated slide transition.
     * direction: 1 = next (slide left), -1 = prev (slide right)
     */
    selectModel(index: number, direction: number): void {
        if (this.models.length === 0) return;
        const newIndex = ((index % this.models.length) + this.models.length) % this.models.length;
        if (newIndex === this.currentModelIndex && !this.transition) return;

        // If already transitioning, finish it instantly
        if (this.transition) {
            this.finishTransition();
        }

        const fromIndex = this.currentModelIndex;
        const toIndex = newIndex;

        // Keep current clones as "from" set
        const fromClones = this.activeClones;
        this.activeClones = [];

        this.currentModelIndex = toIndex;

        this.transition = {
            fromIndex,
            toIndex,
            direction,
            startTime: performance.now(),
            fromClones,
            toClones: [], // will be populated during render
        };
    }

    /** Instantly finish any active transition. */
    private finishTransition(): void {
        if (!this.transition) return;
        // Remove old clones
        for (const clone of this.transition.fromClones) {
            this.scene.remove(clone);
        }
        // Transfer "to" clones to activeClones
        this.activeClones = this.transition.toClones;
        this.transition = null;
    }

    // ==== Params ====

    applyBaseRotation(): void {
        const deg = Math.PI / 180;
        for (const m of this.models) {
            m.pivot.rotation.set(
                this.params.baseRotX * deg,
                this.params.baseRotY * deg,
                this.params.baseRotZ * deg,
            );
            m.pivot.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(m.pivot);
            const sz = new THREE.Vector3();
            box.getSize(sz);
            m.width = sz.x;
        }
    }

    updateParams(params: Partial<GlassesParams>): void {
        Object.assign(this.params, params);

        if (
            params.baseRotX !== undefined ||
            params.baseRotY !== undefined ||
            params.baseRotZ !== undefined
        ) {
            this.applyBaseRotation();
            // Destroy active clones so they pick up new rotation
            for (const clone of this.activeClones) this.scene.remove(clone);
            this.activeClones = [];
        }
    }

    // ==== Sizing ====

    /**
     * Set the logical size. Internally renders at SUPERSAMPLE× resolution.
     * The canvas CSS size stays at `width × height`, but the buffer is larger.
     */
    setSize(width: number, height: number): void {
        this.canvasW = width;
        this.canvasH = height;

        const renderW = width * SUPERSAMPLE;
        const renderH = height * SUPERSAMPLE;

        // Set the canvas buffer to the supersampled resolution
        this.renderer.setSize(renderW, renderH, false);
        this.composer.setSize(renderW, renderH, false);

        // CSS size stays at logical size — the browser downscales for us
        this.renderer.domElement.style.width = `${width}px`;
        this.renderer.domElement.style.height = `${height}px`;

        // Camera uses logical coords (matching face landmark pixel space)
        const hw = width / 2;
        const hh = height / 2;
        this.camera.left = -hw;
        this.camera.right = hw;
        this.camera.top = hh;
        this.camera.bottom = -hh;
        this.camera.updateProjectionMatrix();
    }

    // ==== Render ====

    render(poses: FacePose[]): void {
        const now = performance.now();

        // ---- Update clipping plane ----
        if (this.params.clipDepth > 0 && poses.length > 0) {
            const pose = poses[0];
            const faceRotation = this.getFaceRotation(pose);

            // Plane normal = face forward direction (toward camera)
            const normal = new THREE.Vector3(0, 0, 1).applyEuler(faceRotation);

            // Glasses position in ortho space
            const yOff = pose.eyeDistance * this.params.offsetY;
            const gx = pose.center.x - this.canvasW / 2;
            const gy = -(pose.center.y + yOff - this.canvasH / 2);
            const forward = normal.clone();
            const depthOff = pose.eyeDistance * this.params.depth;
            const glassesPos = new THREE.Vector3(
                gx + forward.x * depthOff,
                gy + forward.y * depthOff,
                forward.z * depthOff,
            );

            // Position the plane behind the glasses center by clipDepth
            const clipOffset = pose.eyeDistance * this.params.clipDepth;
            const planePoint = glassesPos.clone().add(normal.clone().multiplyScalar(-clipOffset));

            this.clipPlane.normal.copy(normal);
            this.clipPlane.constant = -planePoint.dot(normal);
        } else {
            // No clipping — push the plane far away so it clips nothing
            this.clipPlane.normal.set(0, 0, 1);
            this.clipPlane.constant = 99999;
        }

        // ---- Occluders ----
        this.renderOccluders(poses);

        // ---- Transition ----
        let outgoingYOffset = 0;
        let incomingYOffset = 0;

        if (this.transition) {
            const elapsed = now - this.transition.startTime;
            const t = Math.min(elapsed / TRANSITION_DURATION, 1);
            const e = ease(t);

            // Old model drops down out of view, new model drops in from above
            const dist = this.canvasH;
            outgoingYOffset = -(e * dist);     // current slides down
            incomingYOffset = (1 - e) * dist;  // new comes from top

            // Render outgoing (from) clones
            if (this.transition.fromIndex >= 0) {
                const fromModel = this.models[this.transition.fromIndex];
                this.renderGlassesSet(
                    poses,
                    fromModel,
                    this.transition.fromClones,
                    outgoingYOffset,
                );
            }

            // Render incoming (to) clones
            const toModel = this.models[this.transition.toIndex];
            this.ensureClones(this.transition.toClones, toModel.template, poses.length);
            this.renderGlassesSet(
                poses,
                toModel,
                this.transition.toClones,
                incomingYOffset,
            );

            if (t >= 1) {
                this.finishTransition();
            }
        } else if (this.currentModelIndex >= 0) {
            // Normal render — no transition
            const model = this.models[this.currentModelIndex];
            this.ensureClones(this.activeClones, model.template, poses.length);
            this.renderGlassesSet(poses, model, this.activeClones, 0);
        }

        this.composer.render();
    }

    private renderOccluders(poses: FacePose[]): void {
        if (!this.occluderTemplate) return;

        while (this.activeOccluders.length < poses.length) {
            const occ = this.occluderTemplate.clone();
            occ.renderOrder = 0;
            this.scene.add(occ);
            this.activeOccluders.push(occ);
        }

        for (let i = 0; i < this.activeOccluders.length; i++) {
            const occ = this.activeOccluders[i];
            if (i >= poses.length) {
                occ.visible = false;
                continue;
            }

            const pose = poses[i];
            occ.visible = true;

            const faceRotation = this.getFaceRotation(pose);
            const s = (pose.faceHeight / this.occluderBaseHeight) * 0.9;
            occ.scale.set(s * 0.8, s, s);
            occ.rotation.copy(faceRotation);

            const ox = pose.faceCenter.x - this.canvasW / 2;
            const oy = -(pose.faceCenter.y - this.canvasH / 2);

            const forward = new THREE.Vector3(0, 0, 1).applyEuler(faceRotation);
            const zOff = pose.faceHeight * this.params.occluderZ;
            occ.position.set(
                ox + forward.x * zOff,
                oy + forward.y * zOff,
                forward.z * zOff,
            );
        }
    }

    private ensureClones(
        clones: THREE.Object3D[],
        template: THREE.Object3D,
        count: number,
    ): void {
        while (clones.length < count) {
            const clone = template.clone();
            clone.renderOrder = 1;
            clone.traverse((child) => {
                if (child instanceof THREE.Mesh) child.renderOrder = 1;
            });
            this.scene.add(clone);
            clones.push(clone);
        }
    }

    private renderGlassesSet(
        poses: FacePose[],
        model: PreloadedModel,
        clones: THREE.Object3D[],
        yOffset: number,
    ): void {
        for (let i = 0; i < clones.length; i++) {
            const clone = clones[i];
            if (i >= poses.length) {
                clone.visible = false;
                continue;
            }

            const pose = poses[i];
            clone.visible = true;

            const paramYOff = pose.eyeDistance * this.params.offsetY;
            const baseX = pose.center.x - this.canvasW / 2;
            const baseY = -(pose.center.y + paramYOff - this.canvasH / 2);

            const targetWidth = pose.eyeDistance * this.params.scale;
            const s = targetWidth / model.width;
            clone.scale.set(s, s, s);

            const faceRotation = this.getFaceRotation(pose);
            clone.rotation.copy(faceRotation);

            const forward = new THREE.Vector3(0, 0, 1).applyEuler(faceRotation);
            const depthOff = pose.eyeDistance * this.params.depth;

            clone.position.set(
                baseX + forward.x * depthOff,
                baseY + forward.y * depthOff + yOffset,
                forward.z * depthOff,
            );
        }
    }

    private getFaceRotation(pose: FacePose): THREE.Euler {
        const m = pose.matrix;

        const rot = new THREE.Matrix4();
        rot.set(
            m[0], m[4], m[8],  0,
            m[1], m[5], m[9],  0,
            m[2], m[6], m[10], 0,
            0,    0,    0,     1,
        );

        const S = new THREE.Matrix4().makeScale(-1, 1, 1);
        rot.premultiply(S).multiply(S);

        return new THREE.Euler().setFromRotationMatrix(rot, 'XYZ');
    }

    dispose(): void {
        this.renderer.dispose();
    }
}
