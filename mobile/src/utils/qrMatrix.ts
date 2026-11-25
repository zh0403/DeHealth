/**
 * Pure TypeScript ISO/IEC 18004 QR Code matrix generator.
 * Supports Byte mode, Error Correction Level L, and Versions 1–12 (up to 367 UTF-8 bytes).
 */

export interface QrMatrix {
  readonly size: number;
  readonly version: number;
  readonly modules: readonly (readonly boolean[])[];
}

interface VersionSpec {
  readonly version: number;
  readonly totalCodewords: number;
  readonly ecCodewordsPerBlock: number;
  readonly group1Blocks: number;
  readonly group1DataCodewords: number;
  readonly group2Blocks: number;
  readonly group2DataCodewords: number;
  readonly alignmentCoords: readonly number[];
}

const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecCodewordsPerBlock: 7, group1Blocks: 1, group1DataCodewords: 19, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [] },
  { version: 2, totalCodewords: 44, ecCodewordsPerBlock: 10, group1Blocks: 1, group1DataCodewords: 34, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 18] },
  { version: 3, totalCodewords: 70, ecCodewordsPerBlock: 15, group1Blocks: 1, group1DataCodewords: 55, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 22] },
  { version: 4, totalCodewords: 100, ecCodewordsPerBlock: 20, group1Blocks: 1, group1DataCodewords: 80, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 26] },
  { version: 5, totalCodewords: 134, ecCodewordsPerBlock: 26, group1Blocks: 1, group1DataCodewords: 108, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 30] },
  { version: 6, totalCodewords: 172, ecCodewordsPerBlock: 18, group1Blocks: 2, group1DataCodewords: 68, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 34] },
  { version: 7, totalCodewords: 196, ecCodewordsPerBlock: 20, group1Blocks: 2, group1DataCodewords: 78, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 22, 38] },
  { version: 8, totalCodewords: 242, ecCodewordsPerBlock: 24, group1Blocks: 2, group1DataCodewords: 97, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 24, 42] },
  { version: 9, totalCodewords: 292, ecCodewordsPerBlock: 30, group1Blocks: 2, group1DataCodewords: 116, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 26, 46] },
  { version: 10, totalCodewords: 346, ecCodewordsPerBlock: 18, group1Blocks: 2, group1DataCodewords: 68, group2Blocks: 2, group2DataCodewords: 69, alignmentCoords: [6, 28, 50] },
  { version: 11, totalCodewords: 404, ecCodewordsPerBlock: 20, group1Blocks: 4, group1DataCodewords: 81, group2Blocks: 0, group2DataCodewords: 0, alignmentCoords: [6, 30, 54] },
  { version: 12, totalCodewords: 466, ecCodewordsPerBlock: 24, group1Blocks: 2, group1DataCodewords: 92, group2Blocks: 2, group2DataCodewords: 93, alignmentCoords: [6, 32, 58] }
];

// GF(256) with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255] ?? 0;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

function buildGeneratorPolynomial(ecCount: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i] ?? 0;
    for (let j = 0; j < poly.length; j++) {
      const polyVal = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ polyVal;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(polyVal, factor);
    }
    poly = next;
  }
  return poly;
}

function computeReedSolomonEc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = buildGeneratorPolynomial(ecCount);
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data, 0);

  for (let i = 0; i < data.length; i++) {
    const coef = msg[i] ?? 0;
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] = (msg[i + j] ?? 0) ^ gfMul(gen[j] ?? 0, coef);
      }
    }
  }

  return msg.slice(data.length);
}

function encodeUtf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text);
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + (((code - 0xd800) << 10) | (next - 0xdc00));
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
        i++;
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

function selectVersionSpec(byteLength: number): VersionSpec {
  for (const spec of VERSION_SPECS) {
    const totalDataCodewords =
      spec.group1Blocks * spec.group1DataCodewords +
      spec.group2Blocks * spec.group2DataCodewords;
    const countBits = spec.version >= 10 ? 16 : 8;
    const maxBytes = Math.floor((totalDataCodewords * 8 - 4 - countBits) / 8);
    if (byteLength <= maxBytes) {
      return spec;
    }
  }
  throw new Error(
    `Input of ${byteLength} UTF-8 bytes exceeds QR Version 12-L capacity (367 bytes).`
  );
}

function buildDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const totalDataCodewords =
    spec.group1Blocks * spec.group1DataCodewords +
    spec.group2Blocks * spec.group2DataCodewords;
  const totalDataBits = totalDataCodewords * 8;
  const bits: number[] = [];

  const pushBits = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };

  // Byte mode indicator: 0100
  pushBits(0b0100, 4);
  // Character count indicator
  const countBits = spec.version >= 10 ? 16 : 8;
  pushBits(bytes.length, countBits);

  for (let i = 0; i < bytes.length; i++) {
    pushBits(bytes[i] ?? 0, 8);
  }

  // Terminator (up to 4 zero bits)
  const terminatorLen = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < terminatorLen; i++) {
    bits.push(0);
  }

  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = new Uint8Array(totalDataCodewords);
  const byteCount = bits.length / 8;
  for (let i = 0; i < byteCount; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | (bits[i * 8 + b] ?? 0);
    }
    codewords[i] = val;
  }

  const padBytes = [0xec, 0x11];
  for (let i = byteCount; i < totalDataCodewords; i++) {
    codewords[i] = padBytes[(i - byteCount) % 2] ?? 0xec;
  }

  return codewords;
}

function interleaveCodewords(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < spec.group1Blocks; i++) {
    const block = data.slice(offset, offset + spec.group1DataCodewords);
    offset += spec.group1DataCodewords;
    blocks.push(block);
    ecBlocks.push(computeReedSolomonEc(block, spec.ecCodewordsPerBlock));
  }

  for (let i = 0; i < spec.group2Blocks; i++) {
    const block = data.slice(offset, offset + spec.group2DataCodewords);
    offset += spec.group2DataCodewords;
    blocks.push(block);
    ecBlocks.push(computeReedSolomonEc(block, spec.ecCodewordsPerBlock));
  }

  const result = new Uint8Array(spec.totalCodewords);
  let outIdx = 0;

  const maxDataLen = Math.max(
    spec.group1DataCodewords,
    spec.group2DataCodewords
  );
  for (let col = 0; col < maxDataLen; col++) {
    for (const block of blocks) {
      if (col < block.length) {
        result[outIdx++] = block[col] ?? 0;
      }
    }
  }

  for (let col = 0; col < spec.ecCodewordsPerBlock; col++) {
    for (const ec of ecBlocks) {
      result[outIdx++] = ec[col] ?? 0;
    }
  }

  return result;
}

function computeFormatBits(ecLevelBits: number, maskPattern: number): number {
  const data = (ecLevelBits << 3) | maskPattern;
  let rem = data << 10;
  const poly = 0x537;
  for (let bit = 14; bit >= 10; bit--) {
    if ((rem & (1 << bit)) !== 0) {
      rem ^= poly << (bit - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  const poly = 0x1f25;
  for (let bit = 17; bit >= 12; bit--) {
    if ((rem & (1 << bit)) !== 0) {
      rem ^= poly << (bit - 12);
    }
  }
  return (version << 12) | rem;
}

export function generateQrMatrix(text: string): QrMatrix {
  const utf8Bytes = encodeUtf8Bytes(text);
  const spec = selectVersionSpec(utf8Bytes.length);
  const size = 17 + 4 * spec.version;

  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false)
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false)
  );

  const setFunctionModule = (r: number, c: number, dark: boolean): void => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r]![c] = dark;
      reserved[r]![c] = true;
    }
  };

  const placeFinderAndSeparator = (topRow: number, leftCol: number): void => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topRow + dr;
        const c = leftCol + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) {
          continue;
        }
        const isSeparator = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const isOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, !isSeparator && (isOuter || isInner));
      }
    }
  };

  // Finder patterns & separators
  placeFinderAndSeparator(0, 0);
  placeFinderAndSeparator(0, size - 7);
  placeFinderAndSeparator(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunctionModule(6, i, dark);
    setFunctionModule(i, 6, dark);
  }

  // Alignment patterns
  const coords = spec.alignmentCoords;
  for (const centerR of coords) {
    for (const centerC of coords) {
      const overlapsTopLeft = centerR <= 8 && centerC <= 8;
      const overlapsTopRight = centerR <= 8 && centerC >= size - 8;
      const overlapsBottomLeft = centerR >= size - 8 && centerC <= 8;
      if (overlapsTopLeft || overlapsTopRight || overlapsBottomLeft) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunctionModule(centerR + dr, centerC + dc, dist !== 1);
        }
      }
    }
  }

  // Dark module at (4 * version + 9, 8)
  setFunctionModule(4 * spec.version + 9, 8, true);

  // Reserve format info modules
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8]![i] = true;
      reserved[i]![8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = true;
  }
  for (let i = 0; i < 7; i++) {
    reserved[size - 1 - i]![8] = true;
  }

  // Version info (versions >= 7)
  if (spec.version >= 7) {
    const versionBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((versionBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunctionModule(a, b, dark);
      setFunctionModule(b, a, dark);
    }
  }

  // Build data + EC bitstream
  const dataCodewords = buildDataCodewords(utf8Bytes, spec);
  const finalCodewords = interleaveCodewords(dataCodewords, spec);
  const totalBits = finalCodewords.length * 8;

  // Place data bits in zigzag order with Mask 0: (r + c) % 2 === 0
  let bitIdx = 0;
  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) {
      rightCol = 5;
    }
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let colOffset = 0; colOffset < 2; colOffset++) {
        const c = rightCol - colOffset;
        if (reserved[r]?.[c]) {
          continue;
        }
        let bit = false;
        if (bitIdx < totalBits) {
          const byteVal = finalCodewords[bitIdx >>> 3] ?? 0;
          const bitOffset = 7 - (bitIdx & 7);
          bit = ((byteVal >>> bitOffset) & 1) === 1;
          bitIdx++;
        }
        const mask = (r + c) % 2 === 0;
        modules[r]![c] = mask ? !bit : bit;
      }
    }
    upward = !upward;
  }

  // Write Format Information (EC Level L = 0b01, Mask 0 = 0b000)
  const formatBits = computeFormatBits(0b01, 0);
  const topLeftFormatCoords: readonly (readonly [number, number])[] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  for (let i = 0; i < 15; i++) {
    const dark = ((formatBits >>> i) & 1) === 1;
    const coord = topLeftFormatCoords[i];
    if (!coord) {
      continue;
    }
    const [r1, c1] = coord;
    modules[r1]![c1] = dark;

    if (i < 8) {
      modules[8]![size - 1 - i] = dark;
    } else {
      modules[size - 15 + i]![8] = dark;
    }
  }

  return {
    size,
    version: spec.version,
    modules
  };
}
