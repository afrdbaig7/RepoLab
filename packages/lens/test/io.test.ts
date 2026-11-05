import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedFile, readBoundedText } from "../src/io.js";

describe("bounded file and UTF-8 reads", () => {
  it("accepts an exact-size UTF-8 file and rejects excessive or malformed input", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-read-"));
    try {
      const file = join(root, "input.json");
      await writeFile(file, "🧭");
      expect(await readBoundedText(file, 4)).toBe("🧭");
      await expect(readBoundedFile(file, 3)).rejects.toThrow(/at most/);
      await writeFile(file, Buffer.from([0xff]));
      await expect(readBoundedText(file, 4)).rejects.toThrow();
      await writeFile(file, "\uFEFF🧭");
      expect(await readBoundedText(file, 7)).toBe("\uFEFF🧭");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
