import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

function within(root: string, path: string): boolean {
  const result = relative(root, path);
  return result === "" || !isAbsolute(result) && result !== ".." && !result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function inCheckout(path: string): Promise<boolean> {
  let directory = dirname(path);
  while (true) {
    try { await lstat(join(directory, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export async function resolveTrustedGit(repo: string, pathValue = process.env.PATH ?? ""): Promise<string> {
  const root = await realpath(repo);
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(join(directory, process.platform === "win32" ? "git.exe" : "git"));
      if (within(root, candidate) || await inCheckout(candidate)) continue;
      if (!(await lstat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* An unusable PATH entry is not a reason to execute a local fallback. */ }
  }
  throw new Error("No trusted Git executable outside source checkouts found on absolute PATH entries; install Git in a trusted tool directory");
}
