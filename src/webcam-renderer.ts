/**
 * Draws the mirrored webcam feed onto a 2D canvas.
 */
export class WebcamRenderer {
    private ctx: CanvasRenderingContext2D;

    constructor(private canvas: HTMLCanvasElement) {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get 2d context');
        this.ctx = ctx;
    }

    setSize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    drawFrame(video: HTMLVideoElement): void {
        const { width, height } = this.canvas;
        this.ctx.setTransform(-1, 0, 0, 1, width, 0);
        this.ctx.drawImage(video, 0, 0, width, height);
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
}
