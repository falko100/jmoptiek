import { GlassesRenderer, DEFAULT_PARAMS, type GlassesParams } from './glasses-renderer.ts';
import { renderThumbnail } from './model-thumbnail.ts';
import type { TweakPanel } from './tweak-panel.ts';

export interface GlassesModel {
    name: string;
    url: string;
    /** Per-model param overrides (merged on top of DEFAULT_PARAMS) */
    defaults?: Partial<GlassesParams>;
}

const MODELS: GlassesModel[] = [
    // { name: 'Brille', url: '/glasses/brille.glb' },
    {
        name: 'S Black White Blue',
        url: '/glasses/S_BLACK WHITE_BLUE_complete.glb',
    },
    {
        name: 'Tommy Hilfiger 2338 Gold',
        url: '/glasses/TH_2338.glb',
    },
    {
        name: 'David Beckham 1217 Silver',
        url: '/glasses/DB1217S.glb',
    },
];

const STORAGE_KEY = 'glasses-preview-selected-model';
const OVERRIDES_STORAGE_KEY = 'glasses-preview-model-overrides';

function loadSelectedIndex(): number {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
            const idx = parseInt(raw, 10);
            if (idx >= 0 && idx < MODELS.length) return idx;
        }
    } catch { /* ignore */ }
    return 0;
}

function saveSelectedIndex(idx: number): void {
    try {
        localStorage.setItem(STORAGE_KEY, String(idx));
    } catch { /* ignore */ }
}

/** Load per-model param overrides. Keyed by model index. */
function loadModelOverrides(): Record<number, Partial<GlassesParams>> {
    try {
        const raw = localStorage.getItem(OVERRIDES_STORAGE_KEY);
        if (raw) return JSON.parse(raw) as Record<number, Partial<GlassesParams>>;
    } catch { /* ignore */ }
    return {};
}

function saveModelOverrides(overrides: Record<number, Partial<GlassesParams>>): void {
    try {
        localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
    } catch { /* ignore */ }
}

/** Keys that are saved/restored per model */
const PER_MODEL_KEYS: (keyof GlassesParams)[] = [
    'scale', 'offsetY', 'depth',
];

export interface ModelSelector {
    element: HTMLElement;
    init: () => Promise<void>;
    next: () => void;
    prev: () => void;
    setTweakPanel: (panel: TweakPanel) => void;
}

export function createModelSelector(renderer: GlassesRenderer): ModelSelector {
    const container = document.createElement('div');
    container.id = 'model-selector';

    let currentIdx = loadSelectedIndex();
    const modelOverrides = loadModelOverrides();
    const cards: HTMLDivElement[] = [];
    let tweakPanel: TweakPanel | null = null;

    function updateActiveCard(): void {
        cards.forEach((c, i) => {
            c.classList.toggle('active', i === currentIdx);
        });
    }

    /** Get the effective params for a model: defaults < model defaults < user overrides */
    function getModelParams(idx: number): Partial<GlassesParams> {
        const modelDefaults = MODELS[idx].defaults ?? {};
        const userOverrides = modelOverrides[idx] ?? {};
        const result: Partial<GlassesParams> = {};
        for (const key of PER_MODEL_KEYS) {
            result[key] = userOverrides[key] ?? modelDefaults[key] ?? DEFAULT_PARAMS[key];
        }
        return result;
    }

    /** Save current per-model params from the renderer */
    function saveCurrentModelParams(): void {
        if (currentIdx < 0) return;
        const overrides: Partial<GlassesParams> = {};
        for (const key of PER_MODEL_KEYS) {
            overrides[key] = renderer.params[key];
        }
        modelOverrides[currentIdx] = overrides;
        saveModelOverrides(modelOverrides);
    }

    function selectModel(idx: number, direction: number): void {
        // Save current model's params
        saveCurrentModelParams();

        const count = MODELS.length;
        currentIdx = ((idx % count) + count) % count;
        saveSelectedIndex(currentIdx);
        updateActiveCard();

        // Restore the new model's params
        renderer.updateParams(getModelParams(currentIdx));
        tweakPanel?.syncSliders();

        renderer.selectModel(currentIdx, direction);
    }

    // Create placeholder cards
    for (let i = 0; i < MODELS.length; i++) {
        const card = document.createElement('div');
        card.className = 'model-card';
        if (i === currentIdx) card.classList.add('active');

        const label = document.createElement('span');
        label.className = 'model-card-label';
        label.textContent = MODELS[i].name;
        card.appendChild(label);

        card.addEventListener('click', () => {
            const direction = i > currentIdx ? 1 : -1;
            selectModel(i, direction);
        });

        cards.push(card);
        container.appendChild(card);
    }

    document.body.appendChild(container);

    return {
        element: container,
        setTweakPanel(panel: TweakPanel) {
            tweakPanel = panel;
        },
        async init() {
            await renderer.preloadModels(MODELS.map((m) => m.url));

            // Apply initial model's params
            renderer.updateParams(getModelParams(currentIdx));
            renderer.selectModel(currentIdx, 0);

            // Render 3D thumbnails
            for (let i = 0; i < MODELS.length; i++) {
                renderThumbnail(MODELS[i].url).then((thumbCanvas) => {
                    thumbCanvas.className = 'model-card-thumb';
                    cards[i].insertBefore(thumbCanvas, cards[i].firstChild);
                });
            }
        },
        next() {
            selectModel(currentIdx + 1, 1);
        },
        prev() {
            selectModel(currentIdx - 1, -1);
        },
    };
}
