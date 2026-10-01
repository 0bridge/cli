import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in agent CLI named `name` in `dir` that runs `script` (JavaScript) with bun, and its
 * path. Elsewhere it's the script itself with a shebang; Windows doesn't run those, so there it's
 * a .cmd shim beside the script, the way npm installs claude and codex (spawn.ts runs it through
 * cmd.exe).
 */
export function fakeBin(dir: string, name: string, script: string): string {
  if (process.platform === "win32") {
    writeFileSync(join(dir, `${name}.js`), script);
    const bin = join(dir, `${name}.cmd`);
    writeFileSync(bin, `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    return bin;
  }
  const bin = join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env bun\n${script}`);
  chmodSync(bin, 0o755);
  return bin;
}
