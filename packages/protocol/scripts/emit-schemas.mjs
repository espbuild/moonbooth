// Emit the published JSON Schemas under spec/schemas/ from the
// canonical schema objects in the built package, so the two forms
// cannot drift. Run after `npm run build`.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSchema, receiptSchema } from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
for (const [name, schema] of [
  ["act-manifest.schema.json", manifestSchema],
  ["act-receipt.schema.json", receiptSchema],
]) {
  const path = join(root, "spec", "schemas", name);
  await writeFile(path, JSON.stringify(schema, null, 2) + "\n");
  console.log("wrote", path);
}
