import type { GestureDebugInfo, GestureEvent } from './gesture-detector.ts';

const MAX_LOG_LINES = 50;

const EVENT_STYLES: Record<GestureEvent['type'], { label: string; cls: string }> = {
    hand_enter:       { label: 'HAND ENTER',        cls: 'gd-evt-enter' },
    hand_leave:       { label: 'HAND LEAVE',        cls: 'gd-evt-leave' },
    zone_enter:       { label: 'ZONE ENTER',        cls: 'gd-evt-threshold' },
    zone_leave:       { label: 'ZONE LEAVE',        cls: 'gd-evt-threshold-lost' },
    button_press:     { label: 'BUTTON PRESS',      cls: 'gd-evt-swipe' },
    cooldown_blocked: { label: 'BLOCKED (cooldown)', cls: 'gd-evt-blocked' },
};

export function createGestureDebug(): {
    element: HTMLElement;
    update: (info: GestureDebugInfo) => void;
} {
    const panel = document.createElement('div');
    panel.id = 'gesture-debug';

    const title = document.createElement('div');
    title.className = 'gd-title';
    title.textContent = 'Gesture Debug';
    title.addEventListener('click', () => panel.classList.add('hidden'));
    panel.appendChild(title);

    const stats = document.createElement('div');
    stats.className = 'gd-stats';
    panel.appendChild(stats);

    const logTitle = document.createElement('div');
    logTitle.className = 'gd-log-title';
    logTitle.textContent = 'Event Log';
    panel.appendChild(logTitle);

    const log = document.createElement('div');
    log.className = 'gd-log';
    panel.appendChild(log);

    document.body.appendChild(panel);

    function addLogEntry(evt: GestureEvent): void {
        const style = EVENT_STYLES[evt.type];
        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const detail = evt.detail ? `  ${evt.detail}` : '';
        const entry = document.createElement('div');
        entry.className = `gd-event ${style.cls}`;
        entry.textContent = `${time}  ${style.label}${detail}`;
        log.appendChild(entry);

        while (log.children.length > MAX_LOG_LINES) {
            log.removeChild(log.firstChild!);
        }
        log.scrollTop = log.scrollHeight;
    }

    function progressBar(p: number): string {
        const filled = Math.round(p * 10);
        return '█'.repeat(filled).padEnd(10, '░');
    }

    return {
        element: panel,
        update(info: GestureDebugInfo) {
            const lines: string[] = [
                `<span class="gd-label">Hands</span> <span class="gd-val">${info.handsDetected}</span>`,
                `<span class="gd-label">Cooldown</span> <span class="gd-val">${info.cooldownRemaining > 0 ? info.cooldownRemaining.toFixed(0) + 'ms' : 'ready'}</span>`,
                `<span class="gd-label">Left</span> <span class="gd-val gd-bar">${progressBar(info.leftProgress)}</span> <span class="gd-val">${(info.leftProgress * 100).toFixed(0)}%</span>`,
                `<span class="gd-label">Right</span> <span class="gd-val gd-bar">${progressBar(info.rightProgress)}</span> <span class="gd-val">${(info.rightProgress * 100).toFixed(0)}%</span>`,
            ];

            for (let h = 0; h < info.hands.length; h++) {
                const hand = info.hands[h];
                lines.push(
                    `<span class="gd-hand-label">Hand ${h}</span>`,
                    `<span class="gd-label">  Pos</span> <span class="gd-val">${hand.wristX.toFixed(3)}, ${hand.wristY.toFixed(3)}</span>`,
                    `<span class="gd-label">  Zone</span> <span class="gd-val ${hand.zone ? 'gd-hot' : ''}">${hand.zone ?? 'none'}</span>`,
                );
            }

            stats.innerHTML = lines.join('<br>');

            for (const evt of info.events) {
                addLogEntry(evt);
            }
        },
    };
}
