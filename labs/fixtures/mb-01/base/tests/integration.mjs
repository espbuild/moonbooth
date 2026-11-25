// MB-01 integration suite. Runs against the merged evaluation
// workspace: the final contract, the backend's service, the frontend's
// client, and the shared dataset. Prints one TAP-style line per
// assertion so the harness can award partial credit.
//
//   node tests/integration.mjs [--only name,name]
//
// Exit code is 0 only when every selected assertion passes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? process.argv[onlyArg + 1].split(",") : null;

const contract = JSON.parse(readFileSync(path.join(root, "contract", "api.json"), "utf8"));
const serviceModule = await import(
  pathToFileURL(path.join(root, "src", "backend", "itemsService.mjs")).href
);
const clientModule = await import(
  pathToFileURL(path.join(root, "src", "frontend", "itemsClient.mjs")).href
);
const { ITEMS } = await import(pathToFileURL(path.join(root, "src", "data", "items.mjs")).href);

const assertions = {
  "service-matches-contract": () =>
    serviceModule.SERVICE_SHAPE === contract.itemsResponse.shape,
  "client-matches-contract": () =>
    clientModule.CLIENT_SHAPE === contract.itemsResponse.shape,
  "client-service-roundtrip": () => {
    const service = serviceModule.createItemsService();
    const all = clientModule.fetchAllItems(service, 3);
    return (
      all.length === ITEMS.length &&
      all.every((item, i) => item.id === ITEMS[i].id)
    );
  },
  "dataset-complete": () => ITEMS.length === 7,
};

let failed = 0;
for (const [name, fn] of Object.entries(assertions)) {
  if (only && !only.includes(name)) continue;
  let ok = false;
  try {
    ok = fn() === true;
  } catch {
    ok = false;
  }
  console.log(`${ok ? "ok" : "not ok"} ${name}`);
  if (!ok) failed++;
}
process.exit(failed > 0 ? 1 : 0);
