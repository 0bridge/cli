import { describe, expect, test } from "bun:test";
import { execMarker } from "../src/profile.ts";
import { pick } from "../src/vault.ts";

describe("0b exec", () => {
  test("tells the command which vault environment it runs with; a CLI shim says nothing", () => {
    expect(execMarker(undefined, "dev")).toEqual({ ZEROBRIDGE_ENV: "dev" });
    expect(execMarker(undefined, "prod")).toEqual({ ZEROBRIDGE_ENV: "prod" });
    expect(execMarker("wrangler", "dev")).toEqual({});
  });
});

describe("0b secret import --only", () => {
  const read: [string, string][] = [
    ["OPENAI_API_KEY", "sk-x"],
    ["DATABASE_URL", "postgres://u:p@localhost/app"],
    ["PORT", "3000"],
  ];

  test("without --only, every line", () => {
    expect(pick(read, undefined, ".env")).toEqual(read);
  });

  test("just the named ones, in the file's order", () => {
    expect(pick(read, "PORT, OPENAI_API_KEY", ".env").map(([k]) => k)).toEqual(["OPENAI_API_KEY", "PORT"]);
  });
});
