import qrcode from 'qrcode-generator';

// ---- Icons ----

const CALENDAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
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
    onQR: (cb: () => void) => void;
    /** Regenerate the booking QR for the given model short name */
    setModel: (shortName: string) => void;
}

export function createCanvasButtons(): CanvasButtons {
    let qrCallback: (() => void) | null = null;

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
                    <div class="qr-brand">Digitale Paskamer</div>
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

    qrCard.addEventListener('click', () => qrCallback?.());

    return {
        onQR(cb) { qrCallback = cb; },
        setModel,
    };
}
