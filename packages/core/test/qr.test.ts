/**
 * The QR encoder (src/qr.ts) against a reference encoder's matrices (fixtures/qr, made once with
 * node-qrcode; each file says how), plus the PNG's structure. With zbarimg on the host, the PNG
 * is also decoded.
 *   bun test packages/core/test/qr.test.ts
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  QR_MAX_VERSION,
  alignmentPositions,
  byteCapacity,
  crc32,
  dataCapacity,
  encodeQr,
  formatBits,
  penalty,
  qrMatrix,
  qrPng,
  qrTerminal,
  rawDataModules,
  reedSolomon,
  versionBits,
  type Ecc,
} from "../src/qr.ts";

interface Fixture {
  name: string;
  text: string;
  ecc: Ecc;
  version: number;
  mask: number;
  modules: boolean[][];
}

const DIR = join(import.meta.dir, "fixtures/qr");
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => {
    const lines = readFileSync(join(DIR, f), "utf8").split("\n").filter((l) => l && !l.startsWith("# "));
    const field = (k: string) => lines.find((l) => l.startsWith(`${k}: `))!.slice(k.length + 2);
    return {
      name: f,
      text: field("text"),
      ecc: field("ecc") as Ecc,
      version: Number(field("version")),
      mask: Number(field("mask")),
      modules: lines.filter((l) => /^[#.]+$/.test(l)).map((l) => [...l].map((ch) => ch === "#")),
    };
  });

const show = (m: boolean[][]) => m.map((r) => r.map((v) => (v ? "#" : ".")).join("")).join("\n");

describe("tables", () => {
  test("every version's blocks fill exactly the modules left for data", () => {
    for (let v = 1; v <= QR_MAX_VERSION; v++)
      for (const ecc of ["L", "M"] as const) {
        // Data plus ECC codewords, whole bytes (the rest are remainder bits).
        const eccPerBlock = { L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22], M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24] }[ecc][v]!;
        const total = Math.floor(rawDataModules(v) / 8);
        const blocks = (total - dataCapacity(v, ecc)) / eccPerBlock;
        expect(Number.isInteger(blocks)).toBe(true);
      }
  });

  test("capacities match the standard's byte-mode table", () => {
    // ISO/IEC 18004 table 7, byte mode.
    expect([1, 2, 5, 10, 15].map((v) => byteCapacity(v, "L"))).toEqual([17, 32, 106, 271, 520]);
    expect([1, 2, 5, 10, 15].map((v) => byteCapacity(v, "M"))).toEqual([14, 26, 84, 213, 412]);
  });

  test("alignment pattern centres", () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(14)).toEqual([6, 26, 46, 66]);
    expect(alignmentPositions(15)).toEqual([6, 26, 48, 70]);
  });

  test("format and version information", () => {
    // Annex C examples: M with mask 5 is 100000011001110; version 7 is 000111110010010100.
    expect(formatBits("M", 5).toString(2).padStart(15, "0")).toBe("100000011001110");
    expect(formatBits("L", 0).toString(2).padStart(15, "0")).toBe("111011111000100");
    expect(versionBits(7).toString(2).padStart(18, "0")).toBe("000111110010010100");
  });

  test("Reed–Solomon matches the standard's worked example (1-M, '01234567')", () => {
    const data = Uint8Array.from([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
    expect([...reedSolomon(data, 10)]).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });
});

describe("matrices match the reference encoder", () => {
  test("fixtures cover versions 1, 2, 5 and 10 at both levels", () => {
    expect(fixtures.map((f) => f.version).sort((a, b) => a - b)).toEqual([1, 2, 5, 10]);
    expect(new Set(fixtures.map((f) => f.ecc))).toEqual(new Set(["L", "M"]));
  });

  for (const f of fixtures) {
    test(`${f.name}: version ${f.version}-${f.ecc}, mask ${f.mask}`, () => {
      // With the reference's mask pinned: the codewords and their placement.
      const pinned = encodeQr(f.text, { ecc: f.ecc, mask: f.mask });
      expect(pinned.version).toBe(f.version);
      expect(show(pinned.modules)).toBe(show(f.modules));
      // Choosing the mask on our own lands on the same one, and it scores lowest.
      const chosen = encodeQr(f.text, { ecc: f.ecc });
      expect(chosen.mask).toBe(f.mask);
      expect(show(qrMatrix(f.text, f.ecc))).toBe(show(f.modules));
      const scores = Array.from({ length: 8 }, (_, k) => penalty(encodeQr(f.text, { ecc: f.ecc, mask: k }).modules));
      expect(scores[chosen.mask]).toBe(Math.min(...scores));
    });
  }

  test("the level changes the code", () => {
    const text = "https://0bridge.dev/device?user_code=ABCD2345";
    expect(encodeQr(text, { ecc: "L" }).version).toBe(3);
    expect(encodeQr(text, { ecc: "M" }).version).toBe(4);
    expect(qrMatrix(text)).toEqual(qrMatrix(text, "M"));
  });

  test("a 200-character link fits; past version 15 is refused", () => {
    const link = `https://0bridge.dev/device?user_code=ABCD2345&x=${"y".repeat(160)}`;
    expect(link.length).toBeGreaterThanOrEqual(200);
    expect(encodeQr(link).version).toBeLessThanOrEqual(QR_MAX_VERSION);
    expect(() => qrMatrix("x".repeat(byteCapacity(QR_MAX_VERSION, "M") + 1))).toThrow(RangeError);
    expect(() => qrMatrix("x".repeat(byteCapacity(QR_MAX_VERSION, "L") + 1), "L")).toThrow(/at most 520/);
    expect(() => encodeQr("x", { version: 16 })).toThrow(RangeError);
    // Byte mode counts UTF-8 bytes, not characters.
    expect(encodeQr("é".repeat(7)).version).toBe(1);
    expect(encodeQr("é".repeat(8)).version).toBe(2);
  });
});

describe("terminal", () => {
  const link = "https://0bridge.dev/device?user_code=ABCD2345";
  test("half blocks, two module rows a line, a 2-module quiet zone", () => {
    const out = qrTerminal(link);
    const size = qrMatrix(link, "L").length;
    const lines = out.split("\n");
    expect(lines.length).toBe(Math.ceil((size + 4) / 2));
    for (const l of lines) expect([...l].length).toBe(size + 4);
    expect(out).toMatch(/^[ ▀▄█\n]+$/);
    // The quiet zone is drawn (light) by default: the first line is all full blocks.
    expect(lines[0]).toBe("█".repeat(size + 4));
    // Inverted draws the dark modules instead: the quiet zone is blank.
    expect(qrTerminal(link, { invert: true }).split("\n")[0]).toBe(" ".repeat(size + 4));
  });
});

describe("png", () => {
  const link = "https://0bridge.dev/device?user_code=ABCD2345";
  const png = qrPng(link, { scale: 4, margin: 4 });

  function chunks(b: Uint8Array) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: { type: string; data: Uint8Array; crc: number; ok: boolean }[] = [];
    for (let at = 8; at < b.length; ) {
      const len = v.getUint32(at);
      const type = new TextDecoder().decode(b.subarray(at + 4, at + 8));
      const data = b.subarray(at + 8, at + 8 + len);
      const crc = v.getUint32(at + 8 + len);
      out.push({ type, data, crc, ok: crc === crc32(b.subarray(at + 4, at + 8 + len)) });
      at += 12 + len;
    }
    return out;
  }

  test("signature, IHDR, chunk CRCs", () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const cs = chunks(png);
    expect(cs.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    for (const c of cs) expect(c.ok).toBe(true);
    const ihdr = new DataView(cs[0]!.data.buffer, cs[0]!.data.byteOffset, 13);
    const side = (qrMatrix(link).length + 8) * 4;
    expect([ihdr.getUint32(0), ihdr.getUint32(4)]).toEqual([side, side]);
    expect([...cs[0]!.data.subarray(8)]).toEqual([8, 0, 0, 0, 0]);
    // CRC-32 of "IEND" alone, a well-known constant.
    expect(cs[2]!.crc).toBe(0xae426082);
  });

  test("the pixels are the modules, scaled, inside a white margin", () => {
    const cs = chunks(png);
    const m = qrMatrix(link);
    const side = (m.length + 8) * 4;
    const raw = inflateSync(cs[1]!.data);
    expect(raw.length).toBe((side + 1) * side);
    const px = (x: number, y: number) => raw[y * (side + 1) + 1 + x];
    for (let y = 0; y < side; y++) expect(raw[y * (side + 1)]).toBe(0); // filter: none
    expect(px(0, 0)).toBe(255);
    for (let my = 0; my < m.length; my++) for (let mx = 0; mx < m.length; mx++) expect(px((mx + 4) * 4 + 1, (my + 4) * 4 + 2)).toBe(m[my]![mx] ? 0 : 255);
  });

  const zbar = spawnSync("zbarimg", ["--version"]).status === 0;
  test.skipIf(!zbar)("zbarimg reads it back", () => {
    const file = join(mkdtempSync(join(tmpdir(), "0b-qr-")), "qr.png");
    writeFileSync(file, qrPng(link));
    const r = spawnSync("zbarimg", ["--quiet", "--raw", file], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe(link);
  });
});
