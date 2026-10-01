import { describe, expect, test } from "bun:test";
import { maskNote, noteHasCredential } from "../src/vault.ts";

// Fakes shaped like the real thing; none of them is a credential.
const R2_KEY_ID = "3f9a1c0e7b2d4a6f8e1c3b5d7a9f0e2c";
const R2_SECRET = "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c";
const CF_TOKEN = "Xk3vQ9wLm2Rt7Yp4Zn8Bc1Hd6Jf0Gs5A_e-uT";

describe("vault notes", () => {
  test("a key pasted into a note is caught", () => {
    for (const k of [R2_KEY_ID, R2_SECRET, CF_TOKEN, "sk-proj-abcdefghijklmnopqrstuv"]) expect(noteHasCredential(`R2 read token ${k} for the warehouse`)).toBe(true);
  });
  test("ordinary descriptions are fine", () => {
    for (const n of ["neotax org token, expires 2027-03", "R2 read-only token for the data lake (rotate every 90 days)", "see https://dash.cloudflare.com/profile/api-tokens", "Stripe live key, owner: billing team", "postgres readonly user"])
      expect(noteHasCredential(n)).toBe(false);
  });
  test("lists show the note with the key masked", () => {
    expect(maskNote(`R2 read token ${R2_SECRET} for the warehouse`)).toBe("R2 read token *** for the warehouse");
    expect(maskNote("expires 2027-03")).toBe("expires 2027-03");
  });
});
