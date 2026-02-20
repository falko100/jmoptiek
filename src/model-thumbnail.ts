import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 100;

/** Shared renderer for all thumbnails — renders one at a time then copies to each canvas. */
let sharedRenderer: THREE.WebGLRenderer | null = null;
let sharedEnvMap: THREE.Texture | null = null;

function getSharedRenderer(): THREE.WebGLRenderer {
    if (!sharedRenderer) {
        const canvas = document.createElement('canvas');
        canvas.width = THUMB_WIDTH * 2;
        canvas.height = THUMB_HEIGHT * 2;
        sharedRenderer = new THREE.WebGLRenderer({
            canvas,
            alpha: true,
            antialias: true,
        });
        sharedRenderer.setSize(THUMB_WIDTH * 2, THUMB_HEIGHT * 2, false);
        sharedRenderer.outputColorSpace = THREE.SRGBColorSpace;
        sharedRenderer.toneMapping = THREE.ACESFilmicToneMapping;
        sharedRenderer.toneMappingExposure = 0.8;
        sharedRenderer.setClearColor(0x000000, 0);

        const pmrem = new THREE.PMREMGenerator(sharedRenderer);
        pmrem.compileEquirectangularShader();
        sharedEnvMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
    }
    return sharedRenderer;
}

/**
 * Render a single GLB model into a thumbnail canvas.
 * Returns the canvas element ready to be inserted into the DOM.
 */
export async function renderThumbnail(url: string): Promise<HTMLCanvasElement> {
    const renderer = getSharedRenderer();
    const loader = new GLTFLoader();
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
        }
    });
    for (const obj of toRemove) obj.removeFromParent();

    // Centre and fit
    const box = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    box.getCenter(center);
    model.position.sub(center);

    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    // Scene
    const scene = new THREE.Scene();
    scene.environment = sharedEnvMap;

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(2, 3, 5);
    scene.add(key);

    // Slight tilt to show the glasses at an angle
    const group = new THREE.Group();
    group.add(model);
    group.rotation.x = -0.1;
    group.rotation.y = 0.3;
    scene.add(group);

    // Camera — fit the model
    const aspect = THUMB_WIDTH / THUMB_HEIGHT;
    const halfH = maxDim * 0.65;
    const halfW = halfH * aspect;
    const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);

    // Render
    renderer.render(scene, camera);

    // Copy to a dedicated canvas
    const thumb = document.createElement('canvas');
    thumb.width = THUMB_WIDTH * 2;
    thumb.height = THUMB_HEIGHT * 2;
    thumb.style.width = `${THUMB_WIDTH}px`;
    thumb.style.height = `${THUMB_HEIGHT}px`;
    const ctx = thumb.getContext('2d')!;
    ctx.drawImage(renderer.domElement, 0, 0);

    // Cleanup
    scene.clear();

    return thumb;
}
