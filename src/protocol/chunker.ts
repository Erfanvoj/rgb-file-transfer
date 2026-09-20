import { BYTES_PER_FRAME, HEADER_SIZE_BYTES, MAX_PAYLOAD_SIZE, MAGIC_BYTES, PALETTE } from '../config';
import { PRNG, generateRobustSolitonCDF, sampleDegree, sampleChunkIndices } from './fountain';

export type RGB = { r: number; g: number; b: number };

export interface ChannelThresholds {
  tr: number;
  tg: number;
  tb: number;
}

export interface UnpackedFrame {
  fileId: number;
  seed: number;
  totalChunks: number;
  payload: Uint8Array;
}

const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let curr = i << 8;
  for (let j = 0; j < 8; j++) {
    curr = ((curr & 0x8000) !== 0) ? ((curr << 1) ^ 0x1021) & 0xffff : (curr << 1) & 0xffff;
  }
  CRC16_TABLE[i] = curr;
}

export function calculateCRC16(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

export function unpackFrame(fullFrame: Uint8Array): UnpackedFrame | null {
  if (fullFrame.length < BYTES_PER_FRAME || fullFrame[0] !== MAGIC_BYTES[0] || fullFrame[1] !== MAGIC_BYTES[1]) {
    return null;
  }
  const view = new DataView(fullFrame.buffer, fullFrame.byteOffset, fullFrame.byteLength);
  const receivedCrc = view.getUint16(7, false);
  view.setUint16(7, 0, false);
  const calculatedCrc = calculateCRC16(fullFrame);
  view.setUint16(7, receivedCrc, false);

  if (receivedCrc !== calculatedCrc) {
    return null;
  }

  return {
    fileId: fullFrame[2],
    seed: view.getUint16(3, false),
    totalChunks: view.getUint16(5, false),
    payload: fullFrame.slice(HEADER_SIZE_BYTES, BYTES_PER_FRAME),
  };
}

export function bitsToColorHex(bits: number): string {
  const index = bits & 7;
  return PALETTE[index]?.hex ?? '#000000';
}

/**
 * Screen gamma, IPS backlight bleed, and mobile camera auto-white-balance shift
 * color channels non-linearly. Dynamic min/max channel midpoints per frame provide
 * reliable binary classification without Euclidean distance drift.
 */
export function computeChannelThresholds(calibrationSamples: RGB[]): ChannelThresholds {
  const defaultThresholds: ChannelThresholds = { tr: 128, tg: 128, tb: 128 };
  if (!calibrationSamples || calibrationSamples.length === 0) {
    return defaultThresholds;
  }

  let minR = 255, maxR = 0;
  let minG = 255, maxG = 0;
  let minB = 255, maxB = 0;

  for (let i = 0; i < calibrationSamples.length; i++) {
    const s = calibrationSamples[i];
    if (s.r < minR) minR = s.r;
    if (s.r > maxR) maxR = s.r;
    if (s.g < minG) minG = s.g;
    if (s.g > maxG) maxG = s.g;
    if (s.b < minB) minB = s.b;
    if (s.b > maxB) maxB = s.b;
  }

  const MIN_DYNAMIC_SPAN = 18;
  return {
    tr: maxR - minR >= MIN_DYNAMIC_SPAN ? (minR + maxR) >> 1 : 128,
    tg: maxG - minG >= MIN_DYNAMIC_SPAN ? (minG + maxG) >> 1 : 128,
    tb: maxB - minB >= MIN_DYNAMIC_SPAN ? (minB + maxB) >> 1 : 128,
  };
}

export function colorToBits(
  r: number,
  g: number,
  b: number,
  thresholds: ChannelThresholds = { tr: 128, tg: 128, tb: 128 }
): number {
  const bit2 = r > thresholds.tr ? 1 : 0;
  const bit1 = g > thresholds.tg ? 1 : 0;
  const bit0 = b > thresholds.tb ? 1 : 0;
  return (bit2 << 2) | (bit1 << 1) | bit0;
}

export class Chunker {
  private readonly fileId: number;
  private readonly totalChunks: number;
  private readonly sourceChunks: Uint8Array[];
  private readonly solitonCDF: Float64Array;
  public readonly metadata: { name: string; type: string; size: number };

  constructor(fileBytes: Uint8Array, name = 'unknown', type = 'application/octet-stream') {
    if (!(fileBytes instanceof Uint8Array)) {
      throw new TypeError('Chunker expects a Uint8Array instance');
    }

    this.fileId = Math.floor(Math.random() * 256);
    this.metadata = { name, type, size: fileBytes.length };

    const metaHeader = new TextEncoder().encode(`${JSON.stringify(this.metadata)}\n`);
    const combined = new Uint8Array(metaHeader.length + fileBytes.length);
    combined.set(metaHeader, 0);
    combined.set(fileBytes, metaHeader.length);

    this.totalChunks = Math.max(1, Math.ceil(combined.length / MAX_PAYLOAD_SIZE));
    this.sourceChunks = new Array(this.totalChunks);

    for (let i = 0; i < this.totalChunks; i++) {
      const chunk = new Uint8Array(MAX_PAYLOAD_SIZE);
      const start = i * MAX_PAYLOAD_SIZE;
      const end = Math.min(start + MAX_PAYLOAD_SIZE, combined.length);
      chunk.set(combined.subarray(start, end), 0);
      this.sourceChunks[i] = chunk;
    }

    this.solitonCDF = generateRobustSolitonCDF(this.totalChunks);
  }

  public get total(): number {
    return this.totalChunks;
  }

  public getFrame(seed: number): Uint8Array {
    const seed16 = seed & 0xffff;
    const prng = new PRNG(seed16);

    const degree = sampleDegree(prng, this.solitonCDF);
    const indices = sampleChunkIndices(prng, this.totalChunks, degree);

    const payload = new Uint8Array(MAX_PAYLOAD_SIZE);
    for (let i = 0; i < indices.length; i++) {
      const chunk = this.sourceChunks[indices[i]];
      for (let b = 0; b < MAX_PAYLOAD_SIZE; b++) {
        payload[b] ^= chunk[b];
      }
    }

    const fullFrame = new Uint8Array(BYTES_PER_FRAME);
    const view = new DataView(fullFrame.buffer);

    fullFrame.set(MAGIC_BYTES, 0);
    fullFrame[2] = this.fileId & 0xff;
    view.setUint16(3, seed16, false);
    view.setUint16(5, this.totalChunks, false);
    view.setUint16(7, 0, false);
    fullFrame.set(payload, HEADER_SIZE_BYTES);

    const crc = calculateCRC16(fullFrame);
    view.setUint16(7, crc, false);

    return fullFrame;
  }
}
