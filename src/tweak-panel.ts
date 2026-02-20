import { GlassesRenderer, DEFAULT_PARAMS, type GlassesParams } from './glasses-renderer.ts';

const STORAGE_KEY = 'glasses-preview-params';
const MIGRATION_KEY = 'glasses-preview-v3-migrated';

// One-time migration: clear stale params from v1 (eyeDistance-based scaling)
try {
    if (!localStorage.getItem(MIGRATION_KEY)) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem('glasses-preview-model-overrides');
        localStorage.setItem(MIGRATION_KEY, '1');
    }
} catch { /* ignore */ }

interface SliderDef {
    key: keyof GlassesParams;
    label: string;
    min: number;
    max: number;
    step: number;
}

const SLIDERS: SliderDef[] = [
    { key: 'scale',    label: 'Scale',       min: 0.5, max: 2.0,  step: 0.05 },
    { key: 'offsetY',  label: 'Offset Y',    min: -2,  max: 2,    step: 0.01 },
    { key: 'depth',    label: 'Depth',       min: -3,  max: 3,    step: 0.01 },
    { key: 'baseRotX', label: 'Rot X°',      min: -180, max: 180, step: 1 },
    { key: 'baseRotY', label: 'Rot Y°',      min: -180, max: 180, step: 1 },
    { key: 'baseRotZ', label: 'Rot Z°',      min: -180, max: 180, step: 1 },
];

// ---- localStorage helpers ----

function loadSavedParams(): GlassesParams {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw) as Partial<GlassesParams>;
            return { ...DEFAULT_PARAMS, ...saved };
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_PARAMS };
}

function saveParams(params: GlassesParams): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
    } catch { /* ignore */ }
}

// ---- Public interface ----

export interface TweakPanel {
    element: HTMLElement;
    /** Sync all slider UI elements to match current renderer params */
    syncSliders: () => void;
}

// ---- Panel ----

export function createTweakPanel(renderer: GlassesRenderer): TweakPanel {
    const saved = loadSavedParams();
    renderer.updateParams(saved);

    const panel = document.createElement('div');
    panel.id = 'tweak-panel';

    const heading = document.createElement('div');
    heading.className = 'tweak-title';
    heading.textContent = 'Glasses Tweaks';
    heading.addEventListener('click', () => panel.classList.add('hidden'));
    panel.appendChild(heading);

    // Track slider elements for syncing
    const sliderInputs: HTMLInputElement[] = [];
    const sliderDisplays: HTMLSpanElement[] = [];
    const allSliderDefs: SliderDef[] = [];

    // Glasses sliders
    for (const def of SLIDERS) {
        const { input, valueDisplay } = createSliderRow(panel, def, saved[def.key], (val) => {
            renderer.updateParams({ [def.key]: val });
            saveParams(renderer.params);
        });
        sliderInputs.push(input);
        sliderDisplays.push(valueDisplay);
        allSliderDefs.push(def);
    }

    // Occluder debug toggle
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'tweak-section';
    sectionTitle.textContent = 'Head Occluder';
    panel.appendChild(sectionTitle);

    const toggleRow = document.createElement('div');
    toggleRow.className = 'tweak-toggle-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'show-occluder';
    checkbox.checked = false;

    const toggleLabel = document.createElement('label');
    toggleLabel.htmlFor = 'show-occluder';
    toggleLabel.textContent = 'Show occluder';

    checkbox.addEventListener('change', () => {
        renderer.setShowOccluder(checkbox.checked);
    });

    toggleRow.appendChild(checkbox);
    toggleRow.appendChild(toggleLabel);
    panel.appendChild(toggleRow);

    // ---- Post-processing toggles ----
    const fxSection = document.createElement('div');
    fxSection.className = 'tweak-section';
    fxSection.textContent = 'Post-Processing';
    panel.appendChild(fxSection);

    const effectToggles: { label: string; defaultOn: boolean; setter: (on: boolean) => void }[] = [
        { label: 'Environment Map (IBL)', defaultOn: true, setter: (on) => renderer.setEnvironmentMap(on) },
        { label: 'Tone Mapping (ACES)',   defaultOn: true, setter: (on) => renderer.setToneMapping(on) },
        { label: 'Bloom',                 defaultOn: false, setter: (on) => renderer.setBloom(on) },
        { label: 'SMAA Anti-aliasing',    defaultOn: true, setter: (on) => renderer.setSMAA(on) },
    ];

    for (const toggle of effectToggles) {
        const row = document.createElement('div');
        row.className = 'tweak-toggle-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = toggle.defaultOn;

        const lbl = document.createElement('label');
        lbl.textContent = toggle.label;

        cb.addEventListener('change', () => toggle.setter(cb.checked));

        row.appendChild(cb);
        row.appendChild(lbl);
        panel.appendChild(row);
    }

    // Lighting & exposure sliders
    const fxSliders: { label: string; min: number; max: number; step: number; defaultVal: number; setter: (v: number) => void }[] = [
        { label: 'Env Intensity', min: 0, max: 5, step: 0.05, defaultVal: 1.25, setter: (v) => renderer.setEnvironmentIntensity(v) },
        { label: 'Light', min: 0, max: 5, step: 0.05, defaultVal: 1.0, setter: (v) => renderer.setLightIntensity(v) },
        { label: 'Exposure', min: 0, max: 5, step: 0.05, defaultVal: 0.25, setter: (v) => renderer.setExposure(v) },
    ];

    for (const def of fxSliders) {
        const row = document.createElement('div');
        row.className = 'tweak-row';

        const label = document.createElement('label');
        label.textContent = def.label;
        row.appendChild(label);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(def.defaultVal);

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'tweak-value';
        valueDisplay.textContent = def.defaultVal.toFixed(2);

        input.addEventListener('input', () => {
            const val = parseFloat(input.value);
            valueDisplay.textContent = val.toFixed(2);
            def.setter(val);
        });

        row.appendChild(input);
        row.appendChild(valueDisplay);
        panel.appendChild(row);
    }

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'tweak-reset';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => {
        renderer.updateParams({ ...DEFAULT_PARAMS });
        saveParams(renderer.params);
        syncSliders();
    });
    panel.appendChild(resetBtn);

    document.body.appendChild(panel);

    /** Sync all slider UI elements to the current renderer.params values */
    function syncSliders(): void {
        for (let i = 0; i < allSliderDefs.length; i++) {
            const def = allSliderDefs[i];
            const val = renderer.params[def.key];
            sliderInputs[i].value = String(val);
            sliderDisplays[i].textContent = formatValue(val, def.step);
        }
    }

    return { element: panel, syncSliders };
}

function createSliderRow(
    parent: HTMLElement,
    def: SliderDef,
    initialValue: number,
    onChange: (val: number) => void,
): { input: HTMLInputElement; valueDisplay: HTMLSpanElement } {
    const row = document.createElement('div');
    row.className = 'tweak-row';

    const label = document.createElement('label');
    label.textContent = def.label;
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(initialValue);

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'tweak-value';
    valueDisplay.textContent = formatValue(initialValue, def.step);

    input.addEventListener('input', () => {
        const val = parseFloat(input.value);
        valueDisplay.textContent = formatValue(val, def.step);
        onChange(val);
    });

    row.appendChild(input);
    row.appendChild(valueDisplay);
    parent.appendChild(row);

    return { input, valueDisplay };
}

function formatValue(val: number, step: number): string {
    return val.toFixed(step < 1 ? 2 : 0);
}
