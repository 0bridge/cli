import { deflateSync } from "node:zlib";

/**
 * QR codes for sign-in links (round 2, P2): on a terminal (half blocks) and as a PNG for agents
 * that can show images. Our own encoder, no dependencies (ISO/IEC 18004): byte mode, ECC L or M,
 * versions 1–15 (a 200-character URL fits from version 10 up), Reed–Solomon over GF(256) with the
 * 0x11d polynomial, and the mask with the lowest penalty. Checked against a reference encoder's
 * matrices (test/fixtures/qr) and a decoder.
 */

export type Ecc = "L" | "M";

/** Versions this encoder makes: 15 holds 412 bytes at M, far more than a sign-in link. */
export const QR_MAX_VERSION = 15;

/**
 * Per version (index 1–15), per level: ECC codewords per block, then [blocks, data codewords
 * per block] for each group (ISO/IEC 18004 table 9).
 */
const BLOCKS: Record<Ecc, [number, [number, number][]][]> = {
  L: [
    [0, []],
    [7, [[1, 19]]],
    [10, [[1, 34]]],
    [15, [[1, 55]]],
    [20, [[1, 80]]],
    [26, [[1, 108]]],
    [18, [[2, 68]]],
    [20, [[2, 78]]],
    [24, [[2, 97]]],
    [30, [[2, 116]]],
    [18, [[2, 68], [2, 69]]],
    [20, [[4, 81]]],
    [24, [[2, 92], [2, 93]]],
    [26, [[4, 107]]],
    [30, [[3, 115], [1, 116]]],
    [22, [[5, 87], [1, 88]]],
  ],
  M: [
    [0, []],
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
    [30, [[1, 50], [4, 51]]],
    [22, [[6, 36], [2, 37]]],
    [22, [[8, 37], [1, 38]]],
    [24, [[4, 40], [5, 41]]],
    [24, [[5, 41], [5, 42]]],
  ],
};

/** The format information's two bits for the level. */
const ECC_BITS: Record<Ecc, number> = { L: 1, M: 0 };

/** Data codewords a version holds at a level. */
export function dataCapacity(version: number, ecc: Ecc): number {
  return BLOCKS[ecc][version]![1].reduce((n, [blocks, size]) => n + blocks * size, 0);
}

/** Modules left for data and ECC once the function patterns are drawn, in bits (remainder bits included). */
export function rawDataModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

/** Bytes of text a version holds in byte mode (4-bit mode, 8- or 16-bit count). */
export function byteCapacity(version: number, ecc: Ecc): number {
  return Math.floor((dataCapacity(version, ecc) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);
}

// ── GF(256) and Reed–Solomon ────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** The generator polynomial of degree `n` (leading 1 left out), highest power first. */
function generator(n: number): Uint8Array {
  const g = new Uint8Array(n);
  g[n - 1] = 1;
  let root = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      g[j] = mul(g[j]!, root);
      if (j + 1 < n) g[j] = g[j]! ^ g[j + 1]!;
    }
    root = mul(root, 2);
  }
  return g;
}

/** The ECC codewords for one block of data: the remainder of data·xⁿ divided by the generator. */
export function reedSolomon(data: Uint8Array, n: number): Uint8Array {
  const g = generator(n);
  const r = new Uint8Array(n);
  for (const b of data) {
    const factor = b ^ r[0]!;
    r.copyWithin(0, 1);
    r[n - 1] = 0;
    for (let i = 0; i < n; i++) r[i] = r[i]! ^ mul(g[i]!, factor);
  }
  return r;
}

// ── Codewords ───────────────────────────────────────────────
/** The data codewords for `bytes` in byte mode, padded to the version's capacity. */
function dataCodewords(bytes: Uint8Array, version: number, ecc: Ecc): Uint8Array {
  const capacity = dataCapacity(version, ecc);
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i++) out[i >>> 3] = out[i >>> 3]! | (bits[i]! << (7 - (i & 7)));
  for (let i = bits.length / 8, pad = 0xec; i < capacity; i++, pad ^= 0xec ^ 0x11) out[i] = pad;
  return out;
}

/** Split into blocks, add each block's ECC, and interleave (data first, then ECC). */
function interleave(data: Uint8Array, version: number, ecc: Ecc): Uint8Array {
  const [eccLen, groups] = BLOCKS[ecc][version]!;
  const blocks: Uint8Array[] = [];
  let at = 0;
  for (const [count, size] of groups)
    for (let i = 0; i < count; i++) {
      blocks.push(data.subarray(at, at + size));
      at += size;
    }
  const eccs = blocks.map((b) => reedSolomon(b, eccLen));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < eccLen; i++) for (const e of eccs) out.push(e[i]!);
  return Uint8Array.from(out);
}

// ── The matrix ──────────────────────────────────────────────
/** Alignment pattern centres along each axis. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** 15 bits: level and mask, BCH(15,5) with 0x537, masked with 0x5412. */
export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 bits for versions 7 and up: the version, BCH(18,6) with 0x1f25. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly size: number;
  /** modules[y][x], true = dark. */
  readonly modules: boolean[][];
  /** Function patterns, which data and masks leave alone. */
  readonly fixed: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.fixed[y]![x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    // Finders with their separators (the light ring around them).
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
    const align = alignmentPositions(this.version);
    for (const ay of align)
      for (const ax of align) {
        // Not over the finders.
        if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    // Reserve the format areas now (drawn for real per mask), and the version blocks.
    this.drawFormat(0, "M");
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  drawFormat(mask: number, ecc: Ecc) {
    const bits = formatBits(ecc, mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true); // the dark module
  }

  /** Codewords in the two-column zigzag, right to left, skipping the vertical timing column. */
  drawData(codewords: Uint8Array) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (this.fixed[y]![x] || i >= codewords.length * 8) continue;
          this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
    }
  }

  /** XOR the mask over the data modules (applying it twice undoes it). */
  applyMask(mask: number) {
    const fn = MASKS[mask]!;
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fixed[y]![x] && fn(x, y)) this.modules[y]![x] = !this.modules[y]![x];
  }
}

/**
 * The penalty score (ISO/IEC 18004 7.8.3): runs of 5+ same-colored modules in a row or column
 * (3, plus 1 per extra module), 2×2 blocks of one color (3 each), finder-like 1:1:3:1:1 patterns
 * with 4 light modules on either side (40 each), and how far dark modules are from half (10 per 5%).
 */
export function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // Each row, then each column, as one line of modules.
  const line = (at: (i: number) => boolean) => {
    let run = 0;
    let bits = 0;
    for (let i = 0; i < size; i++) {
      const dark = at(i);
      if (i > 0 && dark === at(i - 1)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
      bits = ((bits << 1) & 0x7ff) | (dark ? 1 : 0);
      // 1011101 then 0000, or 0000 then 1011101.
      if (i >= 10 && (bits === 0x5d0 || bits === 0x05d)) score += 40;
    }
    if (run >= 5) score += run - 2;
  };
  for (let a = 0; a < size; a++) {
    line((i) => m[a]![i]!);
    line((i) => m[i]![a]!);
  }
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

export interface QrCode {
  version: number;
  ecc: Ecc;
  mask: number;
  /** modules[y][x], true = dark; no quiet zone. */
  modules: boolean[][];
}

/**
 * Encode `text` (UTF-8, byte mode) in the smallest version that holds it. `version` and `mask`
 * pin those (the tests compare against a reference encoder that way); otherwise the mask with the
 * lowest penalty wins, the lowest-numbered one on a tie.
 */
export function encodeQr(text: string, opts: { ecc?: Ecc; version?: number; mask?: number } = {}): QrCode {
  const ecc = opts.ecc ?? "M";
  const bytes = new TextEncoder().encode(text);
  let version = opts.version ?? 0;
  if (!version) {
    for (let v = 1; v <= QR_MAX_VERSION && !version; v++) if (byteCapacity(v, ecc) >= bytes.length) version = v;
    if (!version) throw new RangeError(`too long for a QR code here: ${bytes.length} bytes, at most ${byteCapacity(QR_MAX_VERSION, ecc)} at level ${ecc}`);
  } else if (!Number.isInteger(version) || version < 1 || version > QR_MAX_VERSION) throw new RangeError(`QR versions here are 1 to ${QR_MAX_VERSION}`);
  else if (byteCapacity(version, ecc) < bytes.length) throw new RangeError(`${bytes.length} bytes don't fit version ${version}-${ecc}`);
  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawData(interleave(dataCodewords(bytes, version, ecc), version, ecc));
  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      grid.applyMask(k);
      grid.drawFormat(k, ecc);
      const p = penalty(grid.modules);
      if (p < best) [best, mask] = [p, k];
      grid.applyMask(k);
    }
  }
  grid.applyMask(mask);
  grid.drawFormat(mask, ecc);
  return { version, ecc, mask, modules: grid.modules };
}

/** The modules, true = dark; no quiet zone. Throws a RangeError past version 15. */
export function qrMatrix(text: string, ecc: Ecc = "M"): boolean[][] {
  return encodeQr(text, { ecc }).modules;
}

/**
 * Half blocks (▀▄█) with a 2-module quiet zone, for printing on a terminal: two module rows per
 * line. By default the light modules are drawn (a light-on-dark terminal, the usual case, shows
 * the dark modules as its background); `invert` draws the dark ones, for light backgrounds.
 */
export function qrTerminal(text: string, opts: { invert?: boolean } = {}): string {
  const m = qrMatrix(text, "L");
  const quiet = 2;
  const n = m.length + quiet * 2;
  const ink = (x: number, y: number) => {
    const dark = y >= quiet && x >= quiet && y < n - quiet && x < n - quiet ? m[y - quiet]![x - quiet]! : false;
    // Past the bottom edge (an odd row count) there is nothing to draw.
    if (y >= n) return false;
    return opts.invert ? dark : !dark;
  };
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "";
    for (let x = 0; x < n; x++) {
      const top = ink(x, y);
      const bottom = ink(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Columns `qrTerminal` needs for `text`. */
export const qrTerminalWidth = (text: string) => qrMatrix(text, "L").length + 4;

// ── PNG ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 as PNG chunks use it (ISO 3309). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * An 8-bit grayscale PNG of the code: black modules on white, `scale` pixels per module (8) and
 * a `margin` of light modules around it (4, the quiet zone scanners expect). Level M, so a
 * screenshot that blurs it still scans.
 */
export function qrPng(text: string, opts: { scale?: number; margin?: number } = {}): Uint8Array {
  const m = qrMatrix(text, "M");
  const scale = Math.max(1, Math.floor(opts.scale ?? 8));
  const margin = Math.max(0, Math.floor(opts.margin ?? 4));
  const side = (m.length + margin * 2) * scale;
  // One filter byte (0, none) per row, then a byte per pixel.
  const raw = new Uint8Array((side + 1) * side);
  for (let py = 0; py < side; py++) {
    const row = py * (side + 1);
    const my = Math.floor(py / scale) - margin;
    for (let px = 0; px < side; px++) {
      const mx = Math.floor(px / scale) - margin;
      const dark = my >= 0 && mx >= 0 && my < m.length && mx < m.length && m[my]![mx]!;
      raw[row + 1 + px] = dark ? 0 : 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, side);
  v.setUint32(4, side);
  ihdr.set([8, 0, 0, 0, 0], 8); // bit depth 8, grayscale, deflate, filter 0, no interlace
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
