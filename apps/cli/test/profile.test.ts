import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBin, parseCallback } from "../src/profile.ts";

describe("finding a profile CLI's binary", () => {
  test("PATH first, then a project's node_modules/.bin looking up from the working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "0b-cli-bin-"));
    const bin = join(root, "repo", "node_modules", ".bin");
    const deep = join(root, "repo", "apps", "gateway");
    mkdirSync(bin, { recursive: true });
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(bin, "fakecli"), "#!/bin/sh\n");
    chmodSync(join(bin, "fakecli"), 0o755);
    const path = process.env.PATH;
    try {
      process.env.PATH = join(root, "empty");
      expect(findBin("fakecli", deep)).toBe(join(bin, "fakecli"));
      expect(findBin("fakecli", root)).toBeNull();
      const onPath = join(root, "global");
      mkdirSync(onPath);
      writeFileSync(join(onPath, "fakecli"), "#!/bin/sh\n");
      process.env.PATH = onPath;
      expect(findBin("fakecli", deep)).toBe(join(onPath, "fakecli"));
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("the localhost address pasted after a login over SSH", () => {
  test("only an http localhost address with a port is passed on", () => {
    const ok = parseCallback("  http://localhost:8976/oauth/callback?code=abc&state=xyz ");
    expect(ok).toBeInstanceOf(URL);
    expect((ok as URL).port).toBe("8976");
    expect(parseCallback("http://127.0.0.1:8976/oauth/callback?code=a")).toBeInstanceOf(URL);
    expect(parseCallback("http://[::1]:8976/cb")).toBeInstanceOf(URL);
    for (const bad of ["https://evil.example/oauth/callback?code=a", "http://localhost/cb", "https://localhost:8976/cb", "code=abc", "http://localhost.evil.com:8976/cb"])
      expect(typeof parseCallback(bad)).toBe("string");
  });
});
