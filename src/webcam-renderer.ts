/**
 * Draws the mirrored webcam feed onto a 2D canvas with "cover" behaviour.
 * The video fills the canvas completely, cropping the overflow while
 * maintaining the original aspect ratio.
 */
export class WebcamRenderer {
    private ctx: CanvasRenderingContext2D;

    /** Cover-transform values — used by face tracker to map landmarks. */
    coverDrawW = 1;
    coverDrawH = 1;
    coverOffsetX = 0;
    coverOffsetY = 0;

    constructor(private canvas: HTMLCanvasElement) {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get 2d context');
        this.ctx = ctx;
    }

    setSize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
    }

    drawFrame(video: HTMLVideoElement): void {
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const vw = video.videoWidth || cw;
        const vh = video.videoHeight || ch;

        // Cover: scale video to fill canvas, crop the overflow
        const scale = Math.max(cw / vw, ch / vh);
        const drawW = vw * scale;
        const drawH = vh * scale;
        const offsetX = (cw - drawW) / 2;
        const offsetY = (ch - drawH) / 2;

        // Store for landmark mapping
        this.coverDrawW = drawW;
        this.coverDrawH = drawH;
        this.coverOffsetX = offsetX;
        this.coverOffsetY = offsetY;

        // Draw mirrored
        this.ctx.setTransform(-1, 0, 0, 1, cw, 0);
        this.ctx.drawImage(video, offsetX, offsetY, drawW, drawH);
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
}
