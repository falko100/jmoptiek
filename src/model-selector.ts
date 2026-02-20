import { GlassesRenderer } from './glasses-renderer.ts';

export interface GlassesModel {
    name: string;
    url: string;
}

const MODELS: GlassesModel[] = [
    { name: 'Brille', url: '/glasses/brille.glb' },
    { name: 'S Black White Blue', url: '/glasses/S_BLACK WHITE_BLUE_complete.glb' },
];

const STORAGE_KEY = 'glasses-preview-selected-model';

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

export interface ModelSelector {
    element: HTMLElement;
    /** Preload all models and select the saved one. */
    init: () => Promise<void>;
    next: () => void;
    prev: () => void;
}

export function createModelSelector(renderer: GlassesRenderer): ModelSelector {
    const container = document.createElement('div');
    container.id = 'model-selector';

    let currentIdx = loadSelectedIndex();
    const buttons: HTMLButtonElement[] = [];

    function updateActiveButton(): void {
        buttons.forEach((b, i) => {
            b.classList.toggle('active', i === currentIdx);
        });
    }

    function selectModel(idx: number, direction: number): void {
        const count = MODELS.length;
        currentIdx = ((idx % count) + count) % count;
        saveSelectedIndex(currentIdx);
        updateActiveButton();
        renderer.selectModel(currentIdx, direction);
    }

    for (let i = 0; i < MODELS.length; i++) {
        const btn = document.createElement('button');
        btn.className = 'model-btn';
        btn.textContent = MODELS[i].name;
        if (i === currentIdx) btn.classList.add('active');

        btn.addEventListener('click', () => {
            const direction = i > currentIdx ? 1 : -1;
            selectModel(i, direction);
        });

        buttons.push(btn);
        container.appendChild(btn);
    }

    document.body.appendChild(container);

    return {
        element: container,
        async init() {
            // Preload all models in parallel
            await renderer.preloadModels(MODELS.map((m) => m.url));
            // Select saved model instantly (no animation)
            renderer.selectModel(currentIdx, 0);
        },
        next() {
            selectModel(currentIdx + 1, 1);
        },
        prev() {
            selectModel(currentIdx - 1, -1);
        },
    };
}
