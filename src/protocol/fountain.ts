export class PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  }

  public nextFloat(): number {
    let z = (this.state += 0x6d2b79f5) >>> 0;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  public nextInt(max: number): number {
    if (max <= 1) return 0;
    return Math.floor(this.nextFloat() * max);
  }
}

export function generateRobustSolitonCDF(K: number, c = 0.1, delta = 0.05): Float64Array {
  if (K <= 1) {
    return new Float64Array([1.0]);
  }

  const pdf = new Float64Array(K);

  pdf[0] = 1 / K;
  for (let d = 2; d <= K; d++) {
    pdf[d - 1] = 1 / (d * (d - 1));
  }

  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const M = Math.max(1, Math.min(K, Math.floor(K / R)));

  for (let d = 1; d < M; d++) {
    pdf[d - 1] += R / (d * K);
  }
  if (M <= K) {
    const tauM = (R * Math.log(Math.max(1e-9, R / delta))) / K;
    if (tauM > 0) {
      pdf[M - 1] += tauM;
    }
  }

  let sum = 0;
  for (let i = 0; i < K; i++) {
    sum += pdf[i];
  }

  const cdf = new Float64Array(K);
  let cumulative = 0;
  for (let i = 0; i < K; i++) {
    cumulative += pdf[i] / sum;
    cdf[i] = cumulative;
  }
  cdf[K - 1] = 1.0;

  return cdf;
}

export function sampleDegree(prng: PRNG, cdf: Float64Array): number {
  if (cdf.length <= 1) return 1;

  const r = prng.nextFloat();
  let low = 0;
  let high = cdf.length - 1;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cdf[mid] < r) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low + 1;
}

export function sampleChunkIndices(prng: PRNG, K: number, degree: number): number[] {
  if (K <= 1 || degree <= 1) {
    return [prng.nextInt(Math.max(1, K))];
  }
  if (degree >= K) {
    return Array.from({ length: K }, (_, i) => i);
  }

  const selected = new Set<number>();
  for (let j = K - degree; j < K; j++) {
    const t = prng.nextInt(j + 1);
    if (selected.has(t)) {
      selected.add(j);
    } else {
      selected.add(t);
    }
  }

  return Array.from(selected);
}
