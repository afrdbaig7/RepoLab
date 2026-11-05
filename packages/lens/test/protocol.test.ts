import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { invokeWorker } from "../src/snapshot.js";

const request = () => ({ protocolVersion: 1, id: randomUUID(), operation: "snapshot", repo: process.cwd(), git: process.execPath, output: process.cwd(), base: "base", head: "head", policy: "exact" });
const fake = resolve("test/fake-worker.mjs");
describe("bounded worker process boundary", () => {
  it.each(["wrong-version", "wrong-id", "unsafe-path", "invalid-json", "invalid-utf8", "truncated", "extra", "crash", "oversized", "stderr"])("rejects %s output", async mode => {
    await expect(invokeWorker(request(), process.execPath, undefined, 5000, [fake, mode])).rejects.toThrow();
  });
  it("times out and awaits process termination", async () => {
    await expect(invokeWorker(request(), process.execPath, undefined, 100, [fake, "hang"])).rejects.toThrow(/timeout/);
  });
  it("cancels a running worker", async () => {
    const controller = new AbortController();
    const result = invokeWorker(request(), process.execPath, controller.signal, 5000, [fake, "hang"]);
    setTimeout(() => controller.abort(), 100);
    await expect(result).rejects.toThrow(/canceled/);
  });
  it("real Rust worker rejects malformed, extra, oversized and unsupported request frames", () => {
    const native = resolve("../../target/debug/lens-snapshot" + (process.platform === "win32" ? ".exe" : ""));
    const frame = JSON.stringify(request());
    const inputs = [Buffer.from(frame), Buffer.from(`${frame}\n${frame}\n`), Buffer.alloc(8193, 120), Buffer.from([0xff, 10]), Buffer.from(`${JSON.stringify({ ...request(), protocolVersion: 2 })}\n`), Buffer.from(`${JSON.stringify({ ...request(), operation: "execute" })}\n`)];
    for (const input of inputs) {
      const result = spawnSync(native, [], { input, timeout: 3000, maxBuffer: 65536 });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ protocolVersion: 1, type: "error", complete: true, retryable: false });
    }
  });
});
