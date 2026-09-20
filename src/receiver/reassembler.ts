import { MAX_PAYLOAD_SIZE } from '../config';
import { unpackFrame } from '../protocol/chunker';
import { PRNG, generateRobustSolitonCDF, sampleDegree, sampleChunkIndices } from '../protocol/fountain';

export interface ReassemblerProgress {
  rank: number;
  totalChunks: number;
  percentage: number;
  validPackets: number;
  totalScanned: number;
  effectiveSpeedKbps: number;
}

export interface FileMetadata {
  name: string;
  type: string;
  size?: number;
}

function xorPayloads(dst: Uint8Array, src: Uint8Array): void {
  const dst32 = new Uint32Array(dst.buffer, dst.byteOffset, Math.floor(MAX_PAYLOAD_SIZE / 4));
  const src32 = new Uint32Array(src.buffer, src.byteOffset, Math.floor(MAX_PAYLOAD_SIZE / 4));
  for (let i = 0; i < dst32.length; i++) {
    dst32[i] ^= src32[i];
  }
  for (let i = dst32.length * 4; i < MAX_PAYLOAD_SIZE; i++) {
    dst[i] ^= src[i];
  }
}

export class Reassembler {
  private fileId = -1;
  private totalChunks = 0;
  private numWords = 0;
  private resolved: (Uint8Array | null)[] = [];
  private resolvedCount = 0;
  private basis: (Uint32Array | null)[] = [];
  private basisPayload: (Uint8Array | null)[] = [];
  private basisMaxWord: number[] = [];
  private colToEquations: (Set<number> | null)[] = [];
  private rank = 0;
  private solitonCDF: Float64Array | null = null;

  private validPackets = 0;
  private totalScanned = 0;
  private startTime = 0;

  private readonly onProgress: (stats: ReassemblerProgress) => void;
  private readonly onComplete: (blobUrl: string, metadata: FileMetadata) => void;

  constructor(
    onProgress: (stats: ReassemblerProgress) => void,
    onComplete: (blobUrl: string, metadata: FileMetadata) => void
  ) {
    this.onProgress = onProgress;
    this.onComplete = onComplete;
  }

  public recordScannedFrame(): void {
    this.totalScanned++;
    this.emitProgress();
  }

  public handleFrame(fullFrame: Uint8Array): boolean {
    const packet = unpackFrame(fullFrame);
    if (!packet) return false;
    this.handlePacket(packet.fileId, packet.totalChunks, packet.seed, packet.payload);
    return true;
  }

  public handlePacket(fileId: number, totalChunks: number, seed: number, payload: Uint8Array): void {
    if (totalChunks <= 0) return;

    if (this.fileId !== -1 && this.fileId !== fileId) {
      this.reset();
    }

    if (this.fileId === -1) {
      this.fileId = fileId;
      this.totalChunks = totalChunks;
      this.numWords = Math.ceil(totalChunks / 32);
      this.resolved = new Array(totalChunks).fill(null);
      this.resolvedCount = 0;
      this.basis = new Array(totalChunks).fill(null);
      this.basisPayload = new Array(totalChunks).fill(null);
      this.basisMaxWord = new Array(totalChunks).fill(0);
      this.colToEquations = new Array(totalChunks).fill(null);
      this.rank = 0;
      this.solitonCDF = generateRobustSolitonCDF(totalChunks);
      this.startTime = performance.now();
    }

    if (this.resolvedCount === this.totalChunks) {
      return;
    }

    this.validPackets++;

    const prng = new PRNG(seed);
    const degree = sampleDegree(prng, this.solitonCDF!);
    const indices = sampleChunkIndices(prng, this.totalChunks, degree);

    const unresolvedIndices: number[] = [];
    const P = new Uint8Array(MAX_PAYLOAD_SIZE);
    P.set(payload.subarray(0, Math.min(payload.length, MAX_PAYLOAD_SIZE)));

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      if (idx < 0 || idx >= this.totalChunks) continue;

      if (this.resolved[idx] !== null) {
        xorPayloads(P, this.resolved[idx]!);
      } else {
        unresolvedIndices.push(idx);
      }
    }

    if (unresolvedIndices.length === 0) {
      this.emitProgress();
      return;
    }

    if (unresolvedIndices.length === 1) {
      this.resolveChunk(unresolvedIndices[0], P);
      this.emitProgress();
      if (this.resolvedCount === this.totalChunks) {
        this.reassembleAndComplete();
      }
      return;
    }

    const v = new Uint32Array(this.numWords);
    let maxW = 0;
    for (let i = 0; i < unresolvedIndices.length; i++) {
      const idx = unresolvedIndices[i];
      const w = idx >>> 5;
      v[w] |= (1 << (idx & 31));
      if (w > maxW) maxW = w;
    }

    let inserted = false;

    for (let w = 0; w <= maxW; w++) {
      let word = v[w];
      while (word !== 0) {
        const bit = 31 - Math.clz32(word & -word);
        const col = (w << 5) + bit;

        if (col >= this.totalChunks) break;

        if (this.resolved[col] !== null) {
          xorPayloads(P, this.resolved[col]!);
          v[w] ^= (1 << bit);
          word = v[w];
          continue;
        }

        if (this.basis[col] !== null) {
          const bVec = this.basis[col]!;
          const bPayload = this.basisPayload[col]!;
          const bMaxW = this.basisMaxWord[col];
          if (bMaxW > maxW) maxW = bMaxW;

          for (let k = w; k <= maxW; k++) {
            v[k] ^= bVec[k];
          }
          xorPayloads(P, bPayload);
          word = v[w];
        } else {
          let count = 0;
          let singleIdx = -1;
          for (let k = w; k <= maxW; k++) {
            let cw = v[k];
            while (cw !== 0) {
              const cbit = 31 - Math.clz32(cw & -cw);
              singleIdx = (k << 5) + cbit;
              count++;
              if (count > 1) break;
              cw &= cw - 1;
            }
            if (count > 1) break;
          }

          if (count === 1 && singleIdx >= 0) {
            this.resolveChunk(singleIdx, P);
          } else if (count > 1) {
            this.basis[col] = v;
            this.basisPayload[col] = P;
            this.basisMaxWord[col] = maxW;
            this.rank++;

            for (let kw = w; kw <= maxW; kw++) {
              let kwWord = v[kw];
              while (kwWord !== 0) {
                const kbit = 31 - Math.clz32(kwWord & -kwWord);
                const kcol = (kw << 5) + kbit;
                if (kcol < this.totalChunks) {
                  if (!this.colToEquations[kcol]) {
                    this.colToEquations[kcol] = new Set<number>();
                  }
                  this.colToEquations[kcol]!.add(col);
                }
                kwWord &= kwWord - 1;
              }
            }
          }

          inserted = true;
          break;
        }
      }
      if (inserted) break;
    }

    this.emitProgress();

    if (this.resolvedCount === this.totalChunks) {
      this.reassembleAndComplete();
    }
  }

  private clearBasisEquation(c: number): void {
    if (this.basis[c] === null) return;
    const bVec = this.basis[c]!;
    const maxW = this.basisMaxWord[c];

    for (let w = 0; w <= maxW; w++) {
      let word = bVec[w];
      while (word !== 0) {
        const bit = 31 - Math.clz32(word & -word);
        const col = (w << 5) + bit;
        if (col < this.totalChunks && this.colToEquations[col]) {
          this.colToEquations[col]!.delete(c);
        }
        word &= word - 1;
      }
    }

    this.basis[c] = null;
    this.basisPayload[c] = null;
    this.rank--;
  }

  private resolveChunk(idx: number, chunkPayload: Uint8Array): void {
    if (this.resolved[idx] !== null) return;

    this.resolved[idx] = chunkPayload;
    this.resolvedCount++;

    if (this.basis[idx] !== null) {
      this.clearBasisEquation(idx);
    }

    const eqSet = this.colToEquations[idx];
    if (!eqSet || eqSet.size === 0) return;

    const candidateEqs = Array.from(eqSet);
    const wordIdx = idx >>> 5;
    const bitMask = 1 << (idx & 31);
    const pendingResolutions: Array<{ idx: number; payload: Uint8Array }> = [];

    for (let i = 0; i < candidateEqs.length; i++) {
      const c = candidateEqs[i];
      if (this.basis[c] === null) continue;
      const bVec = this.basis[c]!;

      if ((bVec[wordIdx] & bitMask) !== 0) {
        bVec[wordIdx] ^= bitMask;
        eqSet.delete(c);
        const bPayload = this.basisPayload[c]!;
        xorPayloads(bPayload, chunkPayload);

        let count = 0;
        let singleIdx = -1;
        const maxW = this.basisMaxWord[c];

        for (let k = 0; k <= maxW; k++) {
          let cw = bVec[k];
          while (cw !== 0) {
            const cbit = 31 - Math.clz32(cw & -cw);
            singleIdx = (k << 5) + cbit;
            count++;
            if (count > 1) break;
            cw &= cw - 1;
          }
          if (count > 1) break;
        }

        if (count === 0) {
          this.clearBasisEquation(c);
        } else if (count === 1 && singleIdx >= 0) {
          const sPayload = new Uint8Array(bPayload);
          this.clearBasisEquation(c);
          pendingResolutions.push({ idx: singleIdx, payload: sPayload });
        }
      }
    }

    for (let p = 0; p < pendingResolutions.length; p++) {
      this.resolveChunk(pendingResolutions[p].idx, pendingResolutions[p].payload);
    }
  }

  public reset(): void {
    this.fileId = -1;
    this.totalChunks = 0;
    this.numWords = 0;
    this.resolved = [];
    this.resolvedCount = 0;
    this.basis = [];
    this.basisPayload = [];
    this.basisMaxWord = [];
    this.colToEquations = [];
    this.rank = 0;
    this.solitonCDF = null;
    this.validPackets = 0;
    this.totalScanned = 0;
    this.startTime = 0;
  }

  private emitProgress(): void {
    const totalSolved = Math.min(this.totalChunks, this.resolvedCount + this.rank);
    const percentage = this.totalChunks > 0 ? Math.round((totalSolved / this.totalChunks) * 100) : 0;
    const elapsedSec = this.startTime > 0 ? Math.max(0.001, (performance.now() - this.startTime) / 1000) : 0.001;
    const effectiveBytes = totalSolved * MAX_PAYLOAD_SIZE;
    const effectiveSpeedKbps = Number(((effectiveBytes / elapsedSec) / 1024).toFixed(1));

    this.onProgress({
      rank: totalSolved,
      totalChunks: this.totalChunks,
      percentage: Math.min(100, percentage),
      validPackets: this.validPackets,
      totalScanned: this.totalScanned,
      effectiveSpeedKbps: totalSolved > 0 ? effectiveSpeedKbps : 0,
    });
  }

  private reassembleAndComplete(): void {
    const totalBytes = this.totalChunks * MAX_PAYLOAD_SIZE;
    const fullBuffer = new Uint8Array(totalBytes);
    for (let i = 0; i < this.totalChunks; i++) {
      const chunk = this.resolved[i];
      if (!chunk) return;
      fullBuffer.set(chunk, i * MAX_PAYLOAD_SIZE);
    }

    const newlineIndex = fullBuffer.indexOf(10);
    if (newlineIndex === -1) return;

    const metaBytes = fullBuffer.slice(0, newlineIndex);
    const metaStr = new TextDecoder().decode(metaBytes);
    let metadata: FileMetadata;
    try {
      metadata = JSON.parse(metaStr);
    } catch {
      return;
    }

    const originalSize = metadata.size !== undefined ? metadata.size : (fullBuffer.length - newlineIndex - 1);
    const fileData = fullBuffer.slice(newlineIndex + 1, newlineIndex + 1 + originalSize);

    const blob = new Blob([fileData], { type: metadata.type || 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);

    this.onComplete(blobUrl, metadata);
    this.reset();
  }
}
