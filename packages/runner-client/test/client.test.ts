import { describe, expect, it } from "vitest";
import { runnerBinaryAvailable } from "../src/index.js";

describe("runner client boundary", () => {
  it("does not claim an arbitrary repository executable is a runner", async () => {
    expect(await runnerBinaryAvailable("C:/definitely-not-a-repolab-runner")).toBe(false);
  });
});
