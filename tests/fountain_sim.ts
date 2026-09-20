if (typeof URL !== 'undefined' && typeof (URL as any).createObjectURL !== 'function') {
  (URL as any).createObjectURL = (_blob: any) => 'blob:mock-test-url';
}

import { Chunker, calculateCRC16 } from '../src/protocol/chunker';
import { Reassembler } from '../src/receiver/reassembler';
import { PRNG, generateRobustSolitonCDF, sampleDegree, sampleChunkIndices } from '../src/protocol/fountain';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testFountainPRNGAndSoliton() {
  console.log('--- Test 1: PRNG Determinism & Soliton Distribution ---');
  const prng1 = new PRNG(12345);
  const prng2 = new PRNG(12345);

  for (let i = 0; i < 100; i++) {
    const f1 = prng1.nextFloat();
    const f2 = prng2.nextFloat();
    assert(f1 === f2, `PRNG float mismatch at step ${i}`);
  }

  for (const K of [1, 2, 5, 20, 100, 1000, 20000]) {
    const cdf = generateRobustSolitonCDF(K);
    assert(cdf.length === K, `CDF length mismatch for K=${K}`);
    assert(Math.abs(cdf[K - 1] - 1.0) < 1e-6, `CDF last value must be 1.0 for K=${K}`);

    const prng = new PRNG(42);
    for (let i = 0; i < 50; i++) {
      const deg = sampleDegree(prng, cdf);
      assert(deg >= 1 && deg <= K, `Degree ${deg} out of bounds [1, ${K}]`);
      const indices = sampleChunkIndices(prng, K, deg);
      assert(indices.length === deg, `Indices length ${indices.length} != degree ${deg}`);
      const unique = new Set(indices);
      assert(unique.size === deg, `Indices must be unique: ${indices}`);
      for (const idx of indices) {
        assert(idx >= 0 && idx < K, `Index ${idx} out of range [0, ${K - 1}]`);
      }
    }
  }
  console.log('✓ PRNG and Soliton distribution test passed!');
}

async function testCRC16() {
  console.log('\n--- Test 2: CRC-16-CCITT Verification ---');
  const data = new Uint8Array([0xab, 0xcd, 0x01, 0x00, 0x05, 0x00, 0x10, 0x00, 0x00, 0x55, 0xaa, 0xff]);
  const crc = calculateCRC16(data);
  assert(crc > 0 && crc <= 0xffff, 'CRC16 must be a valid 16-bit number');

  const corrupt = new Uint8Array(data);
  corrupt[9] ^= 0x01;
  const corruptCrc = calculateCRC16(corrupt);
  assert(crc !== corruptCrc, 'CRC16 must detect single-bit corruption');
  console.log('✓ CRC16 verification test passed!');
}

async function runEndToEndTransferTest(fileSize: number, lossRate: number, shuffle: boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const originalBytes = new Uint8Array(fileSize);
    for (let i = 0; i < fileSize; i++) {
      originalBytes[i] = (i * 31 + 7) & 0xff;
    }

    const fileName = `test_${fileSize}.bin`;
    const mimeType = 'application/octet-stream';
    const chunker = new Chunker(originalBytes, fileName, mimeType);

    const K = chunker.total;
    let completed = false;

    const reassembler = new Reassembler(
      (_stats) => {},
      (_blobUrl, metadata) => {
        completed = true;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        try {
          assert(metadata.name === fileName, `Metadata name mismatch: ${metadata.name}`);
          assert(metadata.type === mimeType, `Metadata type mismatch: ${metadata.type}`);
          assert(metadata.size === fileSize, `Metadata size mismatch: ${metadata.size} != ${fileSize}`);
          console.log(`✓ ${label} passed (K = ${K}, Loss = ${(lossRate * 100).toFixed(0)}%, Size = ${fileSize} bytes) in ${elapsed}s`);
          resolve();
        } catch (err) {
          reject(err);
        }
      }
    );

    if (shuffle) {
      const streamPool: Uint8Array[] = [];
      const totalToGenerate = Math.max(K + 10, Math.ceil(K * (1 / (1 - lossRate + 1e-6)) * 1.5));

      for (let seed = 0; seed < totalToGenerate; seed++) {
        if (Math.random() < lossRate) continue;
        const frame = chunker.getFrame(seed);
        streamPool.push(frame);
      }

      for (let i = streamPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [streamPool[i], streamPool[j]] = [streamPool[j], streamPool[i]];
      }

      for (const frame of streamPool) {
        if (completed) break;
        reassembler.handleFrame(frame);
      }
    }

    let seed = 0;
    const maxSeed = K * 5 + 100;
    while (!completed && seed < maxSeed) {
      if (Math.random() >= lossRate) {
        const frame = chunker.getFrame(seed);
        reassembler.handleFrame(frame);
      }
      seed++;
    }

    assert(completed, `Failed to reconstruct file for ${label}`);
  });
}

async function runAllTests() {
  try {
    await testFountainPRNGAndSoliton();
    await testCRC16();

    console.log('\n--- Test 3: End-to-End Fountain Code Transfers ---');
    await runEndToEndTransferTest(100, 0.0, false, '100B Exact in-order transfer');
    await runEndToEndTransferTest(100, 0.3, true, '100B with 30% loss and shuffled order');

    await runEndToEndTransferTest(5120, 0.0, false, '5KB In-order transfer');
    await runEndToEndTransferTest(5120, 0.25, true, '5KB with 25% loss and shuffled order');

    await runEndToEndTransferTest(50000, 0.2, true, '50KB with 20% loss and shuffled order');
    await runEndToEndTransferTest(200000, 0.15, true, '200KB with 15% loss and shuffled order');
    await runEndToEndTransferTest(500000, 0.1, false, '500KB Stream transfer');
    await runEndToEndTransferTest(1000000, 0.1, false, '1MB Stream transfer');
    await runEndToEndTransferTest(2000000, 0.1, false, '2MB Stream transfer (Stress Test)');

    console.log('\n=========================================');
    console.log('🎉 ALL FOUNTAIN CODE TESTS PASSED 100%! 🎉');
    console.log('=========================================\n');
  } catch (e) {
    console.error('❌ Test failed:', e);
    process.exit(1);
  }
}

runAllTests();
