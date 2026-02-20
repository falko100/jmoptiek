/**
 * Manages webcam access and lifecycle.
 */
export class Camera {
    private stream: MediaStream | null = null;

    constructor(private video: HTMLVideoElement) {}

    /** Start the webcam and wait until video is playing. */
    async start(): Promise<void> {
        this.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'user',
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
            audio: false,
        });

        this.video.srcObject = this.stream;

        await new Promise<void>((resolve) => {
            this.video.onloadedmetadata = () => resolve();
        });
        await this.video.play();
    }

    /** Stop all tracks and release the camera. */
    stop(): void {
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        this.video.srcObject = null;
    }

    get isActive(): boolean {
        return this.stream !== null;
    }

    get videoWidth(): number {
        return this.video.videoWidth;
    }

    get videoHeight(): number {
        return this.video.videoHeight;
    }

    get element(): HTMLVideoElement {
        return this.video;
    }
}
