import qrcode from 'qrcode-generator';
import type { ButtonConfig } from './gesture-detector.ts';

export type GlassesType = 'glasses' | 'sunglasses';

/** Camera feed renders at 820x820 logical px — hand landmarks share this space */
const CAMERA_SIZE = 820;

/** Depth of the edge touch zones (canvas px) */
const EDGE = 120;

/**
 * Hand-touch zones at the edges of the camera feed. The matching buttons
 * live OUTSIDE the camera (in surrounding bars) — linked only by id.
 */
const TOUCH_ZONES: Record<string, ButtonConfig['rect']> = {
    'type-glasses':    { x: 0,                  y: 0,                  w: CAMERA_SIZE / 2, h: EDGE },
    'type-sunglasses': { x: CAMERA_SIZE / 2,    y: 0,                  w: CAMERA_SIZE / 2, h: EDGE },
    'prev':            { x: 0,                  y: EDGE,               w: EDGE,            h: CAMERA_SIZE - 2 * EDGE },
    'next':            { x: CAMERA_SIZE - EDGE, y: EDGE,               w: EDGE,            h: CAMERA_SIZE - 2 * EDGE },
    'paszone':         { x: 0,                  y: CAMERA_SIZE - EDGE, w: CAMERA_SIZE,     h: EDGE },
};

type ButtonId = keyof typeof TOUCH_ZONES;

// ---- Icons ----

const GLASSES_SVG = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="10" cy="17" r="5"/><circle cx="22" cy="17" r="5"/>
  <path d="M15 17h2"/><path d="M5 17H3"/><path d="M29 17h-2"/>
</svg>`;

const SUNGLASSES_SVG = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 17c0-2.8 2.2-5 5-5s5 2.2 5 5v1c0 2.2-1.8 4-4 4H9c-2.2 0-4-1.8-4-4v-1z" fill="currentColor" opacity="0.3"/>
  <path d="M17 17c0-2.8 2.2-5 5-5s5 2.2 5 5v1c0 2.2-1.8 4-4 4h-2c-2.2 0-4-1.8-4-4v-1z" fill="currentColor" opacity="0.3"/>
  <path d="M15 16h2"/><path d="M5 15H3"/><path d="M29 15h-2"/>
</svg>`;

const HAND_SVG = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M11 15V8.5a1.5 1.5 0 0 1 3 0V15"/>
  <path d="M14 15V6.5a1.5 1.5 0 0 1 3 0V15"/>
  <path d="M17 15V8.5a1.5 1.5 0 0 1 3 0V15"/>
  <path d="M20 15V11.5a1.5 1.5 0 0 1 3 0V19c0 5-3.5 9-8 9s-8-4-8-9v-4.5a1.5 1.5 0 0 1 3 0V15"/>
</svg>`;

const CHEVRON_LEFT = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6l-10 10 10 10"/></svg>`;
const CHEVRON_RIGHT = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6l10 10-10 10"/></svg>`;

const PASZONE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
  <path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/>
  <circle cx="12" cy="11" r="2.5"/><path d="M8.5 17c0-2 1.6-3.2 3.5-3.2s3.5 1.2 3.5 3.2"/>
</svg>`;

const CALENDAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
</svg>`;

const SHIELD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3z"/>
</svg>`;

const CLOUD_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 18a4 4 0 0 1-.7-7.94 5.5 5.5 0 0 1 9.2-3.36M19 17.5A4 4 0 0 0 18 10h-1"/>
  <path d="M3 3l18 18"/>
</svg>`;

const PERSON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="8" r="4"/><path d="M5 21v-1a7 7 0 0 1 14 0v1"/>
</svg>`;

/** Generate a scalable QR-code SVG that encodes the given URL */
function qrSvg(url: string): string {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

const BOOKING_BASE = 'https://jmoptiek.nl/afspraak';

function bookingUrl(modelShortName: string): string {
    return `${BOOKING_BASE}?model=${encodeURIComponent(modelShortName)}`;
}

export interface CanvasButtons {
    onTypeChange: (cb: (type: GlassesType) => void) => void;
    onPrev: (cb: () => void) => void;
    onNext: (cb: () => void) => void;
    onPaszone: (cb: () => void) => void;
    onQR: (cb: () => void) => void;
    setType: (type: GlassesType) => void;
    /** Regenerate the booking QR for the given model short name */
    setModel: (shortName: string) => void;
    getButtonConfigs: () => ButtonConfig[];
    setProgress: (id: string, progress: number) => void;
    trigger: (id: string) => void;
}

export function createCanvasButtons(): CanvasButtons {
    let typeCallback: ((type: GlassesType) => void) | null = null;
    let prevCallback: (() => void) | null = null;
    let nextCallback: (() => void) | null = null;
    let paszoneCallback: (() => void) | null = null;
    let qrCallback: (() => void) | null = null;
    let currentType: GlassesType = 'glasses';

    /** Elements that receive dwell-progress / flash feedback, by button id */
    const feedbackEls = new Map<ButtonId, HTMLElement>();

    // ---- Type toggle ----
    const toggle = document.getElementById('type-toggle')!;
    const glassesBtn = document.createElement('button');
    glassesBtn.className = 'type-btn active';
    glassesBtn.innerHTML = `<span class="icon">${GLASSES_SVG}</span>Brillen`;
    const sunBtn = document.createElement('button');
    sunBtn.className = 'type-btn';
    sunBtn.innerHTML = `<span class="icon">${SUNGLASSES_SVG}</span>Zonnebrillen`;
    toggle.append(glassesBtn, sunBtn);

    // ---- Side nav ----
    function buildSideNav(slotId: string, dir: 'left' | 'right'): HTMLButtonElement {
        const slot = document.getElementById(slotId)!;
        const hand = document.createElement('div');
        hand.className = 'side-nav-hand';
        hand.innerHTML = HAND_SVG;
        const btn = document.createElement('button');
        btn.className = 'side-nav-btn';
        btn.innerHTML = `<div class="dwell"></div>${dir === 'left' ? CHEVRON_LEFT : CHEVRON_RIGHT}`;
        slot.append(hand, btn);
        return btn;
    }
    const prevBtn = buildSideNav('side-nav-left', 'left');
    const nextBtn = buildSideNav('side-nav-right', 'right');

    // ---- Paszone overlay ----
    const paszoneSlot = document.getElementById('paszone-slot')!;
    const paszoneBtn = document.createElement('button');
    paszoneBtn.className = 'paszone-btn';
    paszoneBtn.innerHTML = `<span class="icon">${PASZONE_SVG}</span>Paszone`;
    paszoneSlot.appendChild(paszoneBtn);

    // ---- QR card ----
    const qrCard = document.getElementById('qr-card')!;
    qrCard.classList.add('card');
    qrCard.innerHTML = `
        <div class="qr-card">
            <div class="qr-code"></div>
            <div class="qr-divider"></div>
            <div class="qr-info">
                <div class="qr-cal-icon">${CALENDAR_SVG}</div>
                <div class="qr-text">
                    <div class="qr-title">Scan &amp; boek</div>
                    <div class="qr-url">jmoptiek.nl/afspraak</div>
                </div>
            </div>
        </div>`;
    const qrCodeEl = qrCard.querySelector<HTMLElement>('.qr-code')!;

    function setModel(shortName: string): void {
        qrCodeEl.innerHTML = qrSvg(bookingUrl(shortName));
    }
    setModel('');

    qrCard.addEventListener('click', () => trigger('qr'));

    // ---- Privacy card ----
    const privacyCard = document.getElementById('privacy-card')!;
    privacyCard.classList.add('card');
    privacyCard.innerHTML = `
        <div class="privacy-card">
            <div class="privacy-header"><span class="shield">${SHIELD_SVG}</span>Privé</div>
            <div class="privacy-cols">
                <div class="privacy-col"><span class="icon">${PASZONE_SVG}</span><span class="label">Paszone</span></div>
                <div class="privacy-col"><span class="icon">${CLOUD_OFF_SVG}</span><span class="label">Geen opslag</span></div>
                <div class="privacy-col"><span class="icon">${PERSON_SVG}</span><span class="label">Alleen jij</span></div>
            </div>
        </div>`;

    // Map ids to elements that show dwell feedback
    feedbackEls.set('type-glasses', glassesBtn);
    feedbackEls.set('type-sunglasses', sunBtn);
    feedbackEls.set('prev', prevBtn);
    feedbackEls.set('next', nextBtn);
    feedbackEls.set('paszone', paszoneBtn);

    function setType(type: GlassesType): void {
        currentType = type;
        glassesBtn.classList.toggle('active', type === 'glasses');
        sunBtn.classList.toggle('active', type === 'sunglasses');
    }

    function trigger(id: string): void {
        const el = feedbackEls.get(id as ButtonId);
        if (el) {
            el.classList.add('cbtn-flash');
            setTimeout(() => el.classList.remove('cbtn-flash'), 350);
        }
        switch (id) {
            case 'type-glasses':
                if (currentType !== 'glasses') { setType('glasses'); typeCallback?.('glasses'); }
                break;
            case 'type-sunglasses':
                if (currentType !== 'sunglasses') { setType('sunglasses'); typeCallback?.('sunglasses'); }
                break;
            case 'prev': prevCallback?.(); break;
            case 'next': nextCallback?.(); break;
            case 'paszone': paszoneCallback?.(); break;
            case 'qr': qrCallback?.(); break;
        }
    }

    glassesBtn.addEventListener('click', () => trigger('type-glasses'));
    sunBtn.addEventListener('click', () => trigger('type-sunglasses'));
    prevBtn.addEventListener('click', () => trigger('prev'));
    nextBtn.addEventListener('click', () => trigger('next'));
    paszoneBtn.addEventListener('click', () => trigger('paszone'));

    return {
        onTypeChange(cb) { typeCallback = cb; },
        onPrev(cb) { prevCallback = cb; },
        onNext(cb) { nextCallback = cb; },
        onPaszone(cb) { paszoneCallback = cb; },
        onQR(cb) { qrCallback = cb; },
        setType,
        setModel,
        getButtonConfigs() {
            return Object.entries(TOUCH_ZONES).map(([id, rect]) => ({ id, rect }));
        },
        setProgress(id, progress) {
            const el = feedbackEls.get(id as ButtonId);
            if (!el) return;
            el.style.setProperty('--progress', String(progress));
            if (id === 'prev' || id === 'next') {
                const dwell = el.querySelector<HTMLElement>('.dwell');
                dwell?.style.setProperty('--progress', String(progress));
            }
        },
        trigger,
    };
}
