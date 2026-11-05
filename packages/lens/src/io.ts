import { open } from "node:fs/promises";

export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new Error(`Input must be a regular file of at most ${limit} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > limit) throw new Error(`Input grew beyond ${limit} bytes during reading`);
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

export async function readBoundedText(path: string, limit: number): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readBoundedFile(path, limit));
}
