import {
  GRID_SIZE,
  BYTES_PER_FRAME,
  PALETTE,
  SENDER_CANVAS_SIZE,
  CELL_SIZE,
  NORMALIZED_BUFFER_SIZE,
  THUMBNAIL_SIZE,
  SYNC_CLOCK_X,
  SYNC_CLOCK_Y,
  SYNC_CLOCK_SIZE,
  CALIBRATION_STRIP_X,
  CALIBRATION_STRIP_Y,
  CALIBRATION_STRIP_WIDTH,
  CALIBRATION_STRIP_HEIGHT,
  CLOCK_LOWER_THRESHOLD,
  CLOCK_UPPER_THRESHOLD,
} from '../config';
import {
  computeChannelThresholds,
  colorToBits,
  unpackFrame,
  type RGB,
} from '../protocol/chunker';
import {
  detectAnchors,
  warpPerspective,
  type Point,
  type CandidateMarker,
  type TrackingState,
} from './anchorDetector';

export type WorkerInMessage =
  | { type: 'INIT' }
  | { type: 'FRAME'; width: number; height: number; buffer: ArrayBuffer };

export interface HudUpdateMessage {
  type: 'HUD_UPDATE';
  state: TrackingState;
  candidates: CandidateMarker[];
  corners: [Point, Point, Point, Point] | null;
  thumbnailBuffer: ArrayBuffer | null;
  frameValid: boolean;
}

export interface ChunkReceivedMessage {
  type: 'CHUNK_RECEIVED';
  fileId: number;
  totalChunks: number;
  seed: number;
  payload: Uint8Array;
}

export type WorkerOutMessage = HudUpdateMessage | ChunkReceivedMessage;

interface WorkerScope {
  postMessage(message: WorkerOutMessage, transfer?: Transferable[]): void;
  onmessage: ((this: WorkerScope, ev: MessageEvent<WorkerInMessage>) => void) | null;
}

const workerScope = self as unknown as WorkerScope;

// Preallocated 3x3 median kernels to prevent GC allocation churn in 60 FPS CV loops
const rKernel = new Uint8Array(9);
const gKernel = new Uint8Array(9);
const bKernel = new Uint8Array(9);

// Hysteresis latch for optical toggle clock: 0 = Low (Black), 1 = High (White)
let lastDecodedClockState: number | null = null;

workerScope.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  if (e.data.type === 'INIT') {
    lastDecodedClockState = null;
    return;
  }

  if (e.data.type === 'FRAME') {
    const data = new Uint8ClampedArray(e.data.buffer);
    processFrame(data, e.data.width, e.data.height);
  }
};

function processFrame(camData: Uint8ClampedArray, width: number, height: number): void {
  const detection = detectAnchors(camData, width, height);

  if (detection.state !== 'ORIENTATION_VERIFIED' || !detection.corners || !detection.homography) {
    workerScope.postMessage({
      type: 'HUD_UPDATE',
      state: detection.state,
      candidates: detection.candidates,
      corners: null,
      thumbnailBuffer: null,
      frameValid: false,
    });
    return;
  }

  const warped = warpPerspective(
    camData,
    width,
    height,
    detection.homography,
    NORMALIZED_BUFFER_SIZE,
    NORMALIZED_BUFFER_SIZE
  );

  const scale = NORMALIZED_BUFFER_SIZE / SENDER_CANVAS_SIZE;

  // Sample top calibration strip to establish dynamic channel baselines
  const stripX = CALIBRATION_STRIP_X * scale;
  const stripWidth = CALIBRATION_STRIP_WIDTH * scale;
  const stripY = CALIBRATION_STRIP_Y * scale;
  const stripHeight = CALIBRATION_STRIP_HEIGHT * scale;

  const numCalibColors = PALETTE.length;
  const calibBlockWidth = stripWidth / numCalibColors;
  const calibrationSamples: RGB[] = [];

  for (let i = 0; i < numCalibColors; i++) {
    const cx = Math.floor(stripX + (i + 0.5) * calibBlockWidth);
    const cy = Math.floor(stripY + stripHeight / 2);
    calibrationSamples.push(getMedian3x3(warped, NORMALIZED_BUFFER_SIZE, NORMALIZED_BUFFER_SIZE, cx, cy));
  }

  const thresholds = computeChannelThresholds(calibrationSamples);

  // Optical Clock Sampling & Rolling Shutter Gating:
  // CMOS rolling shutters capture screen rows progressively. When the sender switches frames,
  // the clock region will exhibit partial luminance (0.25 < L < 0.75) during frame tears.
  // We gate the matrix decode until the clock is cleanly Settled-LOW or Settled-HIGH.
  const clockCenterX = Math.floor((SYNC_CLOCK_X + SYNC_CLOCK_SIZE / 2) * scale);
  const clockCenterY = Math.floor((SYNC_CLOCK_Y + SYNC_CLOCK_SIZE / 2) * scale);
  const clockSample = getMedian3x3(warped, NORMALIZED_BUFFER_SIZE, NORMALIZED_BUFFER_SIZE, clockCenterX, clockCenterY);

  const lRaw = (0.299 * clockSample.r + 0.587 * clockSample.g + 0.114 * clockSample.b) / 255;
  const blackSample = calibrationSamples[0];
  const whiteSample = calibrationSamples[7];
  const lBlack = (0.299 * blackSample.r + 0.587 * blackSample.g + 0.114 * blackSample.b) / 255;
  const lWhite = (0.299 * whiteSample.r + 0.587 * whiteSample.g + 0.114 * whiteSample.b) / 255;

  let L = lRaw;
  if (lWhite - lBlack >= 0.15) {
    L = Math.max(0, Math.min(1, (lRaw - lBlack) / (lWhite - lBlack)));
  }

  let currentClockState = -1;
  if (L <= CLOCK_LOWER_THRESHOLD) {
    currentClockState = 0;
  } else if (L >= CLOCK_UPPER_THRESHOLD) {
    currentClockState = 1;
  }

  const isTransition = currentClockState === -1;
  const isDuplicate = !isTransition && lastDecodedClockState !== null && currentClockState === lastDecodedClockState;

  let frameValid = false;

  if (!isTransition && !isDuplicate) {
    const matrixSize = GRID_SIZE * CELL_SIZE * scale;
    const startX = (NORMALIZED_BUFFER_SIZE - matrixSize) / 2;
    const startY = (NORMALIZED_BUFFER_SIZE - matrixSize) / 2;
    const cellSize = CELL_SIZE * scale;

    const fullFrame = new Uint8Array(BYTES_PER_FRAME);

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const cellIndex = row * GRID_SIZE + col;
        const cx = Math.floor(startX + (col + 0.5) * cellSize);
        const cy = Math.floor(startY + (row + 0.5) * cellSize);

        const color = getMedian3x3(warped, NORMALIZED_BUFFER_SIZE, NORMALIZED_BUFFER_SIZE, cx, cy);
        const bits = colorToBits(color.r, color.g, color.b, thresholds);

        const bitPos = cellIndex * 3;
        const bytePos = bitPos >> 3;
        const bitOffset = bitPos & 7;

        if (bitOffset <= 5) {
          fullFrame[bytePos] |= (bits << (5 - bitOffset));
        } else if (bitOffset === 6) {
          fullFrame[bytePos] |= (bits >> 1);
          if (bytePos + 1 < BYTES_PER_FRAME) {
            fullFrame[bytePos + 1] |= ((bits & 1) << 7);
          }
        } else {
          fullFrame[bytePos] |= ((bits >> 2) & 1);
          if (bytePos + 1 < BYTES_PER_FRAME) {
            fullFrame[bytePos + 1] |= ((bits & 3) << 6);
          }
        }
      }
    }

    const packet = unpackFrame(fullFrame);
    if (packet) {
      frameValid = true;
      lastDecodedClockState = currentClockState;

      workerScope.postMessage(
        {
          type: 'CHUNK_RECEIVED',
          fileId: packet.fileId,
          totalChunks: packet.totalChunks,
          seed: packet.seed,
          payload: packet.payload,
        },
        [packet.payload.buffer as ArrayBuffer]
      );
    }
  }

  const thumb = downsampleBuffer(
    warped,
    NORMALIZED_BUFFER_SIZE,
    NORMALIZED_BUFFER_SIZE,
    THUMBNAIL_SIZE,
    THUMBNAIL_SIZE
  );

  const thumbBuffer = thumb.buffer as ArrayBuffer;

  workerScope.postMessage(
    {
      type: 'HUD_UPDATE',
      state: 'ORIENTATION_VERIFIED',
      candidates: detection.candidates,
      corners: detection.corners,
      thumbnailBuffer: thumbBuffer,
      frameValid,
    },
    [thumbBuffer]
  );
}

function getMedian3x3(
  data: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  cx: number,
  cy: number
): RGB {
  let count = 0;

  for (let dy = -1; dy <= 1; dy++) {
    const ny = Math.max(0, Math.min(imgHeight - 1, cy + dy));
    const rowOffset = ny * imgWidth * 4;

    for (let dx = -1; dx <= 1; dx++) {
      const nx = Math.max(0, Math.min(imgWidth - 1, cx + dx));
      const idx = rowOffset + nx * 4;

      rKernel[count] = data[idx];
      gKernel[count] = data[idx + 1];
      bKernel[count] = data[idx + 2];
      count++;
    }
  }

  rKernel.sort();
  gKernel.sort();
  bKernel.sort();

  return {
    r: rKernel[4],
    g: gKernel[4],
    b: bKernel[4],
  };
}

function downsampleBuffer(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.floor(dy * scaleY);
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.floor(dx * scaleX);
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (dy * dstW + dx) * 4;

      dst[dstIdx] = src[srcIdx];
      dst[dstIdx + 1] = src[srcIdx + 1];
      dst[dstIdx + 2] = src[srcIdx + 2];
      dst[dstIdx + 3] = src[srcIdx + 3];
    }
  }

  return dst;
}
