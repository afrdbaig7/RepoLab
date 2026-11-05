import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { configSchema, reportSchema, requestSchema, responseSchema } from "./contracts.js";
import { testArtifactSchema } from "./artifacts.js";

const directory = new URL("../schemas/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries({ report: reportSchema, request: requestSchema, response: responseSchema, config: configSchema, "test-artifact": testArtifactSchema })) {
  // Path refinements are additionally enforced by Zod; the published schema describes structure.
  const json = `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }), null, 2)}\n`;
  const destination = new URL(`${name}.schema.json`, directory);
  if (process.argv.includes("--check")) {
    if (await readFile(destination, "utf8") !== json) throw new Error(`Schema drift: ${fileURLToPath(destination)}`);
  } else await writeFile(destination, json);
}
