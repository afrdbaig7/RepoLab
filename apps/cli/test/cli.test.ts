import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("CLI starter workflow", () => {
  it("creates a valid manifest without touching application source", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-cli-"));
    await run(process.execPath, [join(process.cwd(), "dist", "index.js"), "init", root]);
    const manifest = await readFile(join(root, ".repolab", "lab.yaml"), "utf8");
    expect(manifest).toContain("schemaVersion: 1");
    expect(manifest).toContain("experiments: []");
  });
});
