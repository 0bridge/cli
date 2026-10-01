import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

describe("redact", () => {
  test("masks credentials by shape", () => {
    const cases = [
      "sk-ant-api03-" + "a".repeat(40),
      "sk-proj-" + "b".repeat(40),
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "ghp_" + "c".repeat(36),
      "xoxb-1234567890-abcdefghij",
      "AIza" + "d".repeat(35),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "0B-" + Array(13).fill("ABCD").join("-"),
    ];
    for (const s of cases) expect(redact(`here: ${s} end`)).toBe("here: [secret] end");
  });
  test("masks values named like secrets and passwords in URLs", () => {
    expect(redact("STRIPE_SECRET_KEY=rk_live_abcdef123456")).toBe("STRIPE_SECRET_KEY=[secret]");
    expect(redact('{"api_key": "abcdef123456"}')).toBe('{"api_key": "[secret]"}');
    expect(redact("postgres://app:hunter2pass@db:5432/x")).toBe("postgres://app:[secret]@db:5432/x");
  });
  test("masks vault values and leaves ordinary text alone", () => {
    expect(redact("the value is corn-flakes-42 ok", ["corn-flakes-42"])).toBe("the value is [secret] ok");
    const plain = "PORT=3000, NODE_ENV=production, see src/token.ts and the password reset flow";
    expect(redact(plain)).toBe(plain);
  });
});
