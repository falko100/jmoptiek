import { GlassesRenderer, DEFAULT_PARAMS, type GlassesParams } from './glasses-renderer.ts';
import { renderThumbnail } from './model-thumbnail.ts';
import type { TweakPanel } from './tweak-panel.ts';

/** Product category — drives the glasses/sunglasses toggle. */
export type GlassesCategory = 'glasses' | 'sunglasses';

export interface GlassesModel {
    name: string;
    url: string;
    /** Short, URL-safe identifier used in the booking QR link */
    shortName: string;
    /** Product category — determines which toggle tab shows this model */
    type: GlassesCategory;
    /** Per-model param overrides (merged on top of DEFAULT_PARAMS) */
    defaults?: Partial<GlassesParams>;
}

/** Payload emitted whenever the selected model changes. */
export interface ModelChange {
    name: string;
    shortName: string;
    /** Category of the selected model */
    type: GlassesCategory;
    /** 0-based index within the current category */
    index: number;
    /** Total number of models in the current category */
    total: number;
}

// `type` marks each model as regular glasses or sunglasses — it drives which
// tab (Brillen / Zonnebrillen) the model appears under.
const MODELS: GlassesModel[] = [
    // { name: 'Brille', url: '/glasses/brille.glb' },
    {
        name: 'Tommy Hilfiger 2338 Gold',
        shortName: 'th2338',
        type: 'glasses',
        url: '/glasses/TH_2338.glb',
    },
    {
        name: 'David Beckham 1217 Silver',
        shortName: 'db1217s',
        type: 'sunglasses',
        url: '/glasses/DB1217S.glb',
    },
    {
        name: 'David Beckham 1237 Gold',
        shortName: 'db1237-gold',
        type: 'glasses',
        url: '/glasses/ARS_Library_Product_Data_2F1107912W85320_2F3dModels_2FurlGlobal_2FDB1237_1107912W85320_CUT_051225_1.glb',
    },
    {
        name: 'David Beckham 1237 Black',
        shortName: 'db1237-black',
        type: 'glasses',
        url: '/glasses/ARS_Library_Product_Data_2F110791KB75320_2F3dModels_2FurlGlobalComplete_2FDB1237_110791KB75320_FULL_051225_3.glb',
    },
    {
        name: 'Smith Lowdown XL2',
        shortName: 'lowdownxl2',
        type: 'sunglasses',
        url: '/glasses/LOWDOWNXL2_201514003601H_CUT.glb',
    },
    {
        name: 'Carrera 1077S Dark Grey Shaded',
        shortName: 'carrera-1077s',
        type: 'sunglasses',
        url: '/glasses/CARRERA 1077S DARK GREY SHADED.glb',
    },
    {
        name: 'David Beckham 1229S Grey',
        shortName: 'db1229s',
        type: 'sunglasses',
        url: '/glasses/DB 1229S GREY ANTIREFLEX.glb',
    },
    {
        name: 'HG 1399S Grey',
        shortName: 'hg1399s',
        type: 'sunglasses',
        url: '/glasses/HG 1399S - GREY.glb',
        // Sits a bit close and clips the nose — nudge it forward.
        defaults: { depth: 0.15 },
    },
    {
        name: 'BOSS 1849',
        shortName: 'boss-1849',
        type: 'glasses',
        url: '/glasses/BOSS 1849 - Kaliber 50.glb',
    },
    {
        name: 'HG 1412',
        shortName: 'hg1412',
        type: 'glasses',
        url: '/glasses/HG 1412 - Kaliber 54 .glb',
    },
];

const STORAGE_KEY = 'glasses-preview-selected-model';
const OVERRIDES_STORAGE_KEY = 'glasses-preview-model-overrides';

// Per-model overrides are keyed by list index, so any change to the model list
// (add/remove/reorder) makes stored overrides point at the wrong model. Clear
// them once whenever the list changes — bump this key to force a fresh reset.
const OVERRIDES_RESET_KEY = 'glasses-preview-overrides-reset-2';
try {
    if (!localStorage.getItem(OVERRIDES_RESET_KEY)) {
        localStorage.removeItem(OVERRIDES_STORAGE_KEY);
        localStorage.setItem(OVERRIDES_RESET_KEY, '1');
    }
} catch { /* ignore */ }

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
    init: (onProgress?: (loaded: number, total: number) => void) => Promise<void>;
    next: () => void;
    prev: () => void;
    setTweakPanel: (panel: TweakPanel) => void;
    /** Short name of the currently selected model */
    currentShortName: () => string;
    /** Category (glasses/sunglasses) of the current selection */
    currentType: () => GlassesCategory;
    /** Switch to a category, selecting its first model (no-op if empty) */
    setType: (type: GlassesCategory) => void;
    /** Switch to the other category (used by the 3-finger gesture) */
    toggleType: () => void;
    /** Fired whenever the selected model changes (incl. initial selection) */
    onChange: (cb: (change: ModelChange) => void) => void;
    /** Re-emit the current selection to the onChange listener */
    refresh: () => void;
}

export function createModelSelector(renderer: GlassesRenderer): ModelSelector {
    // Optional — the production UI has no model-card list (nav is via side buttons)
    const container = document.getElementById('model-selector');

    let currentIdx = loadSelectedIndex();
    let currentType: GlassesCategory = MODELS[currentIdx].type;
    const modelOverrides = loadModelOverrides();
    const cards: HTMLDivElement[] = [];
    let tweakPanel: TweakPanel | null = null;
    let changeCb: ((change: ModelChange) => void) | null = null;

    /** Model indices belonging to a category, in list order. */
    function indicesOfType(type: GlassesCategory): number[] {
        const out: number[] = [];
        MODELS.forEach((m, i) => { if (m.type === type) out.push(i); });
        return out;
    }

    function emitChange(): void {
        const m = MODELS[currentIdx];
        const list = indicesOfType(currentType);
        const pos = list.indexOf(currentIdx);
        changeCb?.({
            name: m.name,
            shortName: m.shortName,
            type: currentType,
            index: pos < 0 ? 0 : pos,
            total: list.length,
        });
    }

    function updateActiveCard(): void {
        cards.forEach((c, i) => {
            c.classList.toggle('active', i === currentIdx);
        });
    }

    /**
     * Effective params for a model. A per-model default declared in code wins
     * (it is the source of truth for that key); keys without a code default
     * fall back to the saved user override, then the global default.
     */
    function getModelParams(idx: number): Partial<GlassesParams> {
        const modelDefaults = MODELS[idx].defaults ?? {};
        const userOverrides = modelOverrides[idx] ?? {};
        const result: Partial<GlassesParams> = {};
        for (const key of PER_MODEL_KEYS) {
            result[key] = modelDefaults[key] ?? userOverrides[key] ?? DEFAULT_PARAMS[key];
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
        currentType = MODELS[currentIdx].type;
        saveSelectedIndex(currentIdx);
        updateActiveCard();

        // Restore the new model's params
        renderer.updateParams(getModelParams(currentIdx));
        tweakPanel?.syncSliders();

        renderer.selectModel(currentIdx, direction);
        emitChange();
    }

    // Create placeholder cards (only when a card container is present)
    if (container) {
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
    }

    return {
        element: container ?? document.createElement('div'),
        setTweakPanel(panel: TweakPanel) {
            tweakPanel = panel;
        },
        async init(onProgress) {
            await renderer.preloadModels(MODELS.map((m) => m.url), onProgress);

            // Apply initial model's params
            renderer.updateParams(getModelParams(currentIdx));
            renderer.selectModel(currentIdx, 0);
            emitChange();

            // Render 3D thumbnails (only if cards exist)
            if (cards.length) {
                for (let i = 0; i < MODELS.length; i++) {
                    renderThumbnail(MODELS[i].url).then((thumbCanvas) => {
                        thumbCanvas.className = 'model-card-thumb';
                        cards[i].insertBefore(thumbCanvas, cards[i].firstChild);
                    });
                }
            }
        },
        next() {
            step(1);
        },
        prev() {
            step(-1);
        },
        currentShortName() {
            return MODELS[currentIdx].shortName;
        },
        currentType() {
            return currentType;
        },
        setType(type: GlassesCategory) {
            if (type === currentType) return;
            const list = indicesOfType(type);
            if (list.length === 0) return; // no models in this category — ignore
            currentType = type;
            const target = list[0];
            selectModel(target, target > currentIdx ? 1 : -1);
        },
        toggleType() {
            this.setType(currentType === 'glasses' ? 'sunglasses' : 'glasses');
        },
        onChange(cb) {
            changeCb = cb;
        },
        refresh() {
            emitChange();
        },
    };

    /** Move to the next/previous model within the current category (wrapping). */
    function step(dir: 1 | -1): void {
        const list = indicesOfType(currentType);
        if (list.length === 0) return;
        const pos = list.indexOf(currentIdx);
        const nextPos = ((pos + dir) % list.length + list.length) % list.length;
        selectModel(list[nextPos], dir);
    }
}
