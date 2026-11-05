import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTrustedGit } from "../src/trusted-git.js";

describe("trusted Git executable discovery", () => {
  it("rejects target checkout, relative and other source-checkout PATH candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-git-tool-"));
    try {
      const repo = join(root, "target");
      const other = join(root, "other-checkout");
      const tool = join(root, "tool-install");
      for (const directory of [repo, other, tool]) await mkdir(directory);
      await mkdir(join(other, ".git"));
      const name = process.platform === "win32" ? "git.exe" : "git";
      for (const directory of [repo, other, tool]) { const file = join(directory, name); await writeFile(file, "This file must never be executed by this test"); await chmod(file, 0o755); }
      await expect(resolveTrustedGit(repo, [".", repo, other].join(delimiter))).rejects.toThrow(/No trusted Git/);
      expect(await resolveTrustedGit(repo, [repo, other, tool].join(delimiter))).toBe(join(tool, name));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
