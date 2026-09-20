import {
  GRID_SIZE,
  PALETTE,
  ANCHOR_SIZE,
  QUIET_MARGIN,
  ANCHOR_COLOR_TL,
  ANCHOR_COLOR_OTHER,
  ANCHOR_COLOR_CENTER,
  CELL_SIZE,
  DATA_CELL_GUARD_RATIO,
  FRAME_HOLD_MS,
  SYNC_CLOCK_X,
  SYNC_CLOCK_Y,
  SYNC_CLOCK_SIZE,
  CALIBRATION_STRIP_X,
  CALIBRATION_STRIP_Y,
  CALIBRATION_STRIP_WIDTH,
  CALIBRATION_STRIP_HEIGHT,
} from '../config';
import { Chunker, bitsToColorHex } from '../protocol/chunker';

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private chunker: Chunker | null = null;
  private isRunning = false;
  private currentFrameIndex = 0;
  private seqId = 0;
  private lastRenderTime = 0;
  private animationFrameId = 0;
  private readonly onProgress: (current: number, total: number) => void;

  constructor(canvas: HTMLCanvasElement, onProgress: (current: number, total: number) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false })!;
    this.onProgress = onProgress;
  }

  public setChunker(chunker: Chunker): void {
    this.chunker = chunker;
  }

  public start(): void {
    if (!this.chunker) {
      throw new Error('Chunker must be initialized before starting renderer');
    }
    this.isRunning = true;
    this.currentFrameIndex = 0;
    this.seqId = 0;
    this.lastRenderTime = performance.now();
    this.renderLoop(this.lastRenderTime);
  }

  public stop(): void {
    this.isRunning = false;
    cancelAnimationFrame(this.animationFrameId);
    this.seqId = 0;

    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private renderLoop = (timestamp: number): void => {
    if (!this.isRunning || !this.chunker) return;

    const frameInterval = FRAME_HOLD_MS;
    const delta = timestamp - this.lastRenderTime;

    if (delta >= frameInterval) {
      this.renderFrame(this.currentFrameIndex, this.seqId);
      this.lastRenderTime = timestamp - (delta % frameInterval);

      this.seqId = (this.seqId + 1) & 0xffff;
      this.currentFrameIndex = (this.currentFrameIndex + 1) & 0xffff;
      this.onProgress(this.currentFrameIndex, this.chunker.total);
    }

    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  };

  private renderFrame(index: number, seqId: number): void {
    if (!this.chunker) return;

    const fullFrame = this.chunker.getFrame(index);
    const { width, height } = this.canvas;

    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, width, height);

    this.drawAnchor(QUIET_MARGIN, QUIET_MARGIN, ANCHOR_COLOR_TL);
    this.drawAnchor(width - QUIET_MARGIN - ANCHOR_SIZE, QUIET_MARGIN, ANCHOR_COLOR_OTHER);
    this.drawAnchor(QUIET_MARGIN, height - QUIET_MARGIN - ANCHOR_SIZE, ANCHOR_COLOR_OTHER);
    this.drawAnchor(width - QUIET_MARGIN - ANCHOR_SIZE, height - QUIET_MARGIN - ANCHOR_SIZE, ANCHOR_COLOR_OTHER);

    if (CALIBRATION_STRIP_WIDTH > 0 && CALIBRATION_STRIP_HEIGHT > 0) {
      const blockWidth = CALIBRATION_STRIP_WIDTH / PALETTE.length;
      for (let i = 0; i < PALETTE.length; i++) {
        this.ctx.fillStyle = PALETTE[i].hex;
        this.ctx.fillRect(CALIBRATION_STRIP_X + i * blockWidth, CALIBRATION_STRIP_Y, blockWidth, CALIBRATION_STRIP_HEIGHT);
      }
    }

    const isClockWhite = (seqId & 1) === 0;
    this.ctx.fillStyle = isClockWhite ? '#FFFFFF' : '#000000';
    this.ctx.fillRect(SYNC_CLOCK_X, SYNC_CLOCK_Y, SYNC_CLOCK_SIZE, SYNC_CLOCK_SIZE);

    const matrixSize = GRID_SIZE * CELL_SIZE;
    const startX = (width - matrixSize) / 2;
    const startY = (height - matrixSize) / 2;

    const gap = CELL_SIZE * DATA_CELL_GUARD_RATIO;
    const drawSize = CELL_SIZE - gap;
    const drawOffset = gap / 2;

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const cellIndex = row * GRID_SIZE + col;
        const bitPos = cellIndex * 3;
        const bytePos = bitPos >> 3;
        const bitOffset = bitPos & 7;

        if (bytePos >= fullFrame.length) break;

        const b0 = fullFrame[bytePos];
        const b1 = (bytePos + 1 < fullFrame.length) ? fullFrame[bytePos + 1] : 0;
        const bits = ((b0 << 8) | b1) >> (13 - bitOffset) & 0x07;

        this.ctx.fillStyle = bitsToColorHex(bits);
        this.ctx.fillRect(
          startX + col * CELL_SIZE + drawOffset,
          startY + row * CELL_SIZE + drawOffset,
          drawSize,
          drawSize
        );
      }
    }
  }

  private drawAnchor(x: number, y: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, ANCHOR_SIZE, ANCHOR_SIZE);

    const dotSize = Math.round(ANCHOR_SIZE * 0.4);
    const dotOffset = Math.round((ANCHOR_SIZE - dotSize) / 2);
    this.ctx.fillStyle = ANCHOR_COLOR_CENTER;
    this.ctx.fillRect(x + dotOffset, y + dotOffset, dotSize, dotSize);
  }
}
