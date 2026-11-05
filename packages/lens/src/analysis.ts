import { Worker } from "node:worker_threads";
import { reportSchema, type Manifest, type Report } from "./contracts.js";
import type { InputFile } from "./extract.js";

export interface AnalysisInput {
  before: InputFile[];
  after: InputFile[];
  manifest: Manifest;
  config: unknown;
  artifact?: string;
}

export async function runAnalysis(input: AnalysisInput, signal?: AbortSignal, timeoutMs = 60000): Promise<Report> {
  signal?.throwIfAborted();
  if (input.artifact !== undefined && Buffer.byteLength(input.artifact) > 65536) throw new Error("Test artifact exceeds 64 KiB");
  if (input.before.length > 4000 || input.after.length > 4000 || [...input.before, ...input.after].reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > 33554432) throw new Error("Analysis input exceeds snapshot limits");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analysis-worker.js", import.meta.url), {
      workerData: input,
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: "" },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
    });
    let result: Report | undefined;
    let settled = false;
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().then(() => reject(error), () => reject(error));
    };
    const cancel = (): void => fail(new Error("Analysis canceled; semantic worker terminated"));
    const timer = setTimeout(() => fail(new Error(`Analysis exceeded ${timeoutMs}ms deadline; semantic worker terminated`)), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message: unknown) => {
      if (settled) return;
      try {
        if (result) throw new Error("Unexpected duplicate analysis result");
        result = reportSchema.parse(message);
      } catch (error) { fail(error instanceof Error ? error : new Error("Invalid analysis result")); }
    });
    worker.once("error", error => fail(new Error(`Analysis worker failed: ${error.message}`)));
    worker.once("exit", code => {
      if (settled) return;
      if (code !== 0 || !result) { fail(new Error(`Analysis worker exited ${code} without a complete report`)); return; }
      settled = true;
      cleanup();
      resolve(result);
    });
    if (signal?.aborted) cancel();
  });
}
