import ts from "typescript";
import { readdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LibraryFile } from "./project.js";
import { readBoundedText } from "./io.js";

// This reads the tool's pinned compiler installation, never target dependencies.
export async function loadTrustedLibraries(): Promise<LibraryFile[]> {
  const root = dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }));
  const files: LibraryFile[] = [];
  let bytes = 0;
  for (const name of (await readdir(root)).sort()) {
    if (!/^lib(?:\.[\w.]+)?\.d\.ts$/.test(name)) continue;
    const path = join(root, name);
    const stat = await lstat(path);
    bytes += stat.size;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error("Trusted compiler library installation violates bounds");
    files.push({ path: name, content: await readBoundedText(path, 4 * 1024 * 1024) });
  }
  return files;
}
