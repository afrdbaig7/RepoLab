import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const python = process.env.LENS_PDF_PYTHON ?? resolve(process.platform === "win32"
  ? ".tools/pdf/Scripts/python.exe" : ".tools/pdf/bin/python");
try { await access(python); }
catch { throw new Error("Create .tools/pdf with python -m venv .tools/pdf and install scripts/learning-docs/requirements.txt in that environment"); }
const child = spawn(python, [resolve("scripts/learning-docs/build.py")], { stdio: "inherit", shell: false, windowsHide: true });
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("close", code => { process.exitCode = code ?? 1; });
