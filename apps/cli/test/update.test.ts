import { describe, expect, test } from "bun:test";
import { installer, isNewer } from "../src/update.ts";

describe("0b update", () => {
  test("versions compare by number, not as text", () => {
    expect(isNewer("0.2.15", "0.2.14")).toBe(true);
    expect(isNewer("0.2.10", "0.2.9")).toBe(true);
    expect(isNewer("0.3.0", "0.2.99")).toBe(true);
    expect(isNewer("0.2.14", "0.2.14")).toBe(false);
    expect(isNewer("0.2.13", "0.2.14")).toBe(false);
  });
  test("updates with the package manager that installed it", () => {
    expect(installer("/usr/local/lib/node_modules/0bridge/dist/0b.js")[0]).toBe("npm");
    expect(installer("/Users/me/.npm-global/lib/node_modules/0bridge/dist/0b.js")[0]).toBe("npm");
    expect(installer("/Users/me/.bun/install/global/node_modules/0bridge/dist/0b.js")[0]).toBe("bun");
    expect(installer("/Users/me/Library/pnpm/global/5/node_modules/0bridge/dist/0b.js")[0]).toBe("pnpm");
    // The exact version just checked, not "latest" (npm may still have the old one cached).
    expect(installer("/usr/local/lib/node_modules/0bridge/dist/0b.js", "0.2.17")).toEqual(["npm", "install", "-g", "0bridge@0.2.17", "--prefer-online"]);
  });
});
