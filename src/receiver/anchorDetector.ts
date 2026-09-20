import {
  SENDER_CANVAS_SIZE,
  ANCHOR_SIZE,
  QUIET_MARGIN,
  NORMALIZED_BUFFER_SIZE,
} from '../config';

export interface Point {
  x: number;
  y: number;
}

export interface CandidateMarker {
  x: number;
  y: number;
  color: 'magenta' | 'cyan';
  size: number;
  score: number;
}

export type TrackingState = 'SEARCHING' | 'ANCHORS_LOCKED' | 'ORIENTATION_VERIFIED';

export interface DetectionResult {
  state: TrackingState;
  corners: [Point, Point, Point, Point] | null;
  candidates: CandidateMarker[];
  homography: number[] | null;
}

interface Blob {
  x: number;
  y: number;
  color: 'magenta' | 'cyan';
  size: number;
  score: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const STRIDE = 2;
const MIN_PEAK_DIFF = 48;
const MIN_CLASSIFIED_PIXELS = 8;
const MIN_BLOB_PIXELS = 3;
const MAX_BLOB_ASPECT_RATIO = 3.85;
const MIN_CW_ANGLE = 0.48;
const MAX_CW_ANGLE = 2.68;
const MIN_QUAD_AREA = 850;

export function detectAnchors(
  data: Uint8ClampedArray,
  width: number,
  height: number
): DetectionResult {
  const gridW = Math.floor(width / STRIDE);
  const gridH = Math.floor(height / STRIDE);
  const totalGrid = gridW * gridH;

  const tagGrid = new Uint8Array(totalGrid);
  const scoreGrid = new Float32Array(totalGrid);

  let classifiedCount = 0;

  for (let gy = 0; gy < gridH; gy++) {
    const y = gy * STRIDE;
    const rowOffset = y * width * 4;
    const gridRowOffset = gy * gridW;

    for (let gx = 0; gx < gridW; gx++) {
      const x = gx * STRIDE;
      const idx = rowOffset + x * 4;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      if (r > g + MIN_PEAK_DIFF && b > g + MIN_PEAK_DIFF) {
        tagGrid[gridRowOffset + gx] = 1;
        scoreGrid[gridRowOffset + gx] = (r - g) + (b - g);
        classifiedCount++;
      } else if (g > r + MIN_PEAK_DIFF && b > r + MIN_PEAK_DIFF) {
        tagGrid[gridRowOffset + gx] = 2;
        scoreGrid[gridRowOffset + gx] = (g - r) + (b - r);
        classifiedCount++;
      }
    }
  }

  if (classifiedCount < MIN_CLASSIFIED_PIXELS) {
    return {
      state: 'SEARCHING',
      corners: null,
      candidates: [],
      homography: null,
    };
  }

  const visited = new Uint8Array(totalGrid);
  const magentaBlobs: Blob[] = [];
  const cyanBlobs: Blob[] = [];

  const queueX = new Int32Array(totalGrid);
  const queueY = new Int32Array(totalGrid);

  for (let gy = 0; gy < gridH; gy++) {
    const gridRowOffset = gy * gridW;
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gridRowOffset + gx;
      const tag = tagGrid[idx];

      if (tag === 0 || visited[idx] === 1) continue;

      const color: 'magenta' | 'cyan' = tag === 1 ? 'magenta' : 'cyan';
      let qHead = 0;
      let qTail = 0;

      queueX[qTail] = gx;
      queueY[qTail] = gy;
      qTail++;
      visited[idx] = 1;

      let sumX = 0;
      let sumY = 0;
      let sumScore = 0;
      let count = 0;
      let minX = gx;
      let maxX = gx;
      let minY = gy;
      let maxY = gy;

      while (qHead < qTail) {
        const curGx = queueX[qHead];
        const curGy = queueY[qHead];
        qHead++;

        const curIdx = curGy * gridW + curGx;
        const curScore = scoreGrid[curIdx];

        sumX += curGx * STRIDE;
        sumY += curGy * STRIDE;
        sumScore += curScore;
        count++;

        if (curGx < minX) minX = curGx;
        if (curGx > maxX) maxX = curGx;
        if (curGy < minY) minY = curGy;
        if (curGy > maxY) maxY = curGy;

        const neighbors = [
          [curGx + 1, curGy],
          [curGx - 1, curGy],
          [curGx, curGy + 1],
          [curGx, curGy - 1],
        ];

        for (let n = 0; n < 4; n++) {
          const nx = neighbors[n][0];
          const ny = neighbors[n][1];

          if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
            const nIdx = ny * gridW + nx;
            if (visited[nIdx] === 0 && tagGrid[nIdx] === tag) {
              visited[nIdx] = 1;
              queueX[qTail] = nx;
              queueY[qTail] = ny;
              qTail++;
            }
          }
        }
      }

      const bw = (maxX - minX + 1) * STRIDE;
      const bh = (maxY - minY + 1) * STRIDE;
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));

      if (count >= MIN_BLOB_PIXELS && aspect <= MAX_BLOB_ASPECT_RATIO) {
        const blob: Blob = {
          x: sumX / count,
          y: sumY / count,
          color,
          size: count,
          score: sumScore,
          minX: minX * STRIDE,
          maxX: maxX * STRIDE,
          minY: minY * STRIDE,
          maxY: maxY * STRIDE,
        };

        if (color === 'magenta') {
          magentaBlobs.push(blob);
        } else {
          cyanBlobs.push(blob);
        }
      }
    }
  }

  magentaBlobs.sort((a, b) => b.size * b.score - a.size * a.score);
  cyanBlobs.sort((a, b) => b.size * b.score - a.size * a.score);

  const candidates: CandidateMarker[] = [
    ...magentaBlobs.map((b) => ({ x: b.x, y: b.y, color: b.color, size: b.size, score: b.score })),
    ...cyanBlobs.map((b) => ({ x: b.x, y: b.y, color: b.color, size: b.size, score: b.score })),
  ];

  if (magentaBlobs.length < 1 || cyanBlobs.length < 3) {
    return {
      state: 'SEARCHING',
      corners: null,
      candidates,
      homography: null,
    };
  }

  let bestQuad: [Point, Point, Point, Point] | null = null;
  let bestScore = -1;

  const topM = Math.min(magentaBlobs.length, 3);
  const topC = Math.min(cyanBlobs.length, 6);

  for (let m = 0; m < topM; m++) {
    const M = magentaBlobs[m];
    const P0: Point = { x: M.x, y: M.y };

    for (let i = 0; i < topC - 2; i++) {
      for (let j = i + 1; j < topC - 1; j++) {
        for (let k = j + 1; k < topC; k++) {
          const C1 = cyanBlobs[i];
          const C2 = cyanBlobs[j];
          const C3 = cyanBlobs[k];

          const cyanPoints: Point[] = [
            { x: C1.x, y: C1.y },
            { x: C2.x, y: C2.y },
            { x: C3.x, y: C3.y },
          ];

          const centerX = (P0.x + cyanPoints[0].x + cyanPoints[1].x + cyanPoints[2].x) / 4;
          const centerY = (P0.y + cyanPoints[0].y + cyanPoints[1].y + cyanPoints[2].y) / 4;

          const angle0 = Math.atan2(P0.y - centerY, P0.x - centerX);

          const sortedCyan = cyanPoints
            .map((p) => {
              const angle = Math.atan2(p.y - centerY, p.x - centerX);
              let diff = angle - angle0;
              while (diff < 0) diff += 2 * Math.PI;
              while (diff >= 2 * Math.PI) diff -= 2 * Math.PI;
              return { p, diff };
            })
            .sort((a, b) => a.diff - b.diff);

          const P1 = sortedCyan[0].p;
          const P2 = sortedCyan[1].p;
          const P3 = sortedCyan[2].p;

          const diff01 = sortedCyan[0].diff;
          const diff12 = sortedCyan[1].diff - sortedCyan[0].diff;
          const diff23 = sortedCyan[2].diff - sortedCyan[1].diff;
          const diff30 = 2 * Math.PI - sortedCyan[2].diff;

          if (
            diff01 < MIN_CW_ANGLE || diff01 > MAX_CW_ANGLE ||
            diff12 < MIN_CW_ANGLE || diff12 > MAX_CW_ANGLE ||
            diff23 < MIN_CW_ANGLE || diff23 > MAX_CW_ANGLE ||
            diff30 < MIN_CW_ANGLE || diff30 > MAX_CW_ANGLE
          ) {
            continue;
          }

          const e0x = P1.x - P0.x, e0y = P1.y - P0.y;
          const e1x = P2.x - P1.x, e1y = P2.y - P1.y;
          const e2x = P3.x - P2.x, e2y = P3.y - P2.y;
          const e3x = P0.x - P3.x, e3y = P0.y - P3.y;

          const z0 = e0x * e1y - e0y * e1x;
          const z1 = e1x * e2y - e1y * e2x;
          const z2 = e2x * e3y - e2y * e3x;
          const z3 = e3x * e0y - e3y * e0x;

          if (z0 <= 0 || z1 <= 0 || z2 <= 0 || z3 <= 0) {
            continue;
          }

          const area = 0.5 * Math.abs(
            (P0.x * P1.y - P1.x * P0.y) +
            (P1.x * P2.y - P2.x * P1.y) +
            (P2.x * P3.y - P3.x * P2.y) +
            (P3.x * P0.y - P0.x * P3.y)
          );

          if (area < MIN_QUAD_AREA) continue;

          const totalBlobSize = M.size + C1.size + C2.size + C3.size;
          const quadScore = area * Math.sqrt(totalBlobSize);

          if (quadScore > bestScore) {
            bestScore = quadScore;
            bestQuad = [P0, P1, P2, P3];
          }
        }
      }
    }
  }

  if (!bestQuad) {
    return {
      state: candidates.length >= 4 ? 'ANCHORS_LOCKED' : 'SEARCHING',
      corners: null,
      candidates,
      homography: null,
    };
  }

  const homography = computeHomographyMatrix(bestQuad, NORMALIZED_BUFFER_SIZE);

  return {
    state: 'ORIENTATION_VERIFIED',
    corners: bestQuad,
    candidates,
    homography,
  };
}

export function computeHomographyMatrix(dst: [Point, Point, Point, Point], normSize: number = NORMALIZED_BUFFER_SIZE): number[] | null {
  const logicalCenterTL = QUIET_MARGIN + ANCHOR_SIZE / 2;
  const logicalCenterBR = SENDER_CANVAS_SIZE - QUIET_MARGIN - ANCHOR_SIZE / 2;

  const scale = normSize / SENDER_CANVAS_SIZE;
  const uTL = logicalCenterTL * scale;
  const uBR = logicalCenterBR * scale;

  const src = [
    { x: uTL, y: uTL },
    { x: uBR, y: uTL },
    { x: uBR, y: uBR },
    { x: uTL, y: uBR },
  ];

  const matrixA: number[][] = [];
  const vectorB: number[] = [];

  for (let i = 0; i < 4; i++) {
    const X = src[i].x;
    const Y = src[i].y;
    const x = dst[i].x;
    const y = dst[i].y;

    matrixA.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x]);
    vectorB.push(x);

    matrixA.push([0, 0, 0, X, Y, 1, -X * y, -Y * y]);
    vectorB.push(y);
  }

  const h = solve8x8(matrixA, vectorB);
  if (!h) return null;

  return [...h, 1];
}

export function warpPerspective(
  camData: Uint8ClampedArray,
  camWidth: number,
  camHeight: number,
  H: number[],
  outWidth: number = NORMALIZED_BUFFER_SIZE,
  outHeight: number = NORMALIZED_BUFFER_SIZE
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);

  const h00 = H[0], h01 = H[1], h02 = H[2];
  const h10 = H[3], h11 = H[4], h12 = H[5];
  const h20 = H[6], h21 = H[7], h22 = H[8];

  for (let v = 0; v < outHeight; v++) {
    const outRowOffset = v * outWidth * 4;
    for (let u = 0; u < outWidth; u++) {
      const w = h20 * u + h21 * v + h22;
      const x = (h00 * u + h01 * v + h02) / w;
      const y = (h10 * u + h11 * v + h12) / w;

      const outIdx = outRowOffset + u * 4;

      if (x >= 0 && x < camWidth - 1 && y >= 0 && y < camHeight - 1) {
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = x0 + 1;
        const y1 = y0 + 1;

        const dx = x - x0;
        const dy = y - y0;
        const w00 = (1 - dx) * (1 - dy);
        const w10 = dx * (1 - dy);
        const w01 = (1 - dx) * dy;
        const w11 = dx * dy;

        const idx00 = (y0 * camWidth + x0) * 4;
        const idx10 = (y0 * camWidth + x1) * 4;
        const idx01 = (y1 * camWidth + x0) * 4;
        const idx11 = (y1 * camWidth + x1) * 4;

        out[outIdx] = Math.round(
          camData[idx00] * w00 + camData[idx10] * w10 + camData[idx01] * w01 + camData[idx11] * w11
        );
        out[outIdx + 1] = Math.round(
          camData[idx00 + 1] * w00 + camData[idx10 + 1] * w10 + camData[idx01 + 1] * w01 + camData[idx11 + 1] * w11
        );
        out[outIdx + 2] = Math.round(
          camData[idx00 + 2] * w00 + camData[idx10 + 2] * w10 + camData[idx01 + 2] * w01 + camData[idx11 + 2] * w11
        );
        out[outIdx + 3] = 255;
      } else {
        out[outIdx] = 0;
        out[outIdx + 1] = 0;
        out[outIdx + 2] = 0;
        out[outIdx + 3] = 255;
      }
    }
  }

  return out;
}

function solve8x8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) {
        maxRow = k;
      }
    }

    const temp = M[i];
    M[i] = M[maxRow];
    M[maxRow] = temp;

    if (Math.abs(M[i][i]) < 1e-8) {
      return null;
    }

    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) {
        M[k][j] -= factor * M[i][j];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }

  return x;
}
