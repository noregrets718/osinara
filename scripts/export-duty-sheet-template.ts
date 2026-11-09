/** Export fictional tab-separated sheets and a source config locally; no Google or database calls. */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createDutySheetSource, dutySheetSections, readDutySheetTables } from "../agent/lib/duty-scheduling/duty-sheet-format.js";
import { previewDutySheetImport } from "../agent/lib/duty-scheduling/duty-sheet-import.js";

const directory = resolve(process.argv[2] ?? ".tmp/duty-sheet-template");
const source = createDutySheetSource("duty-example-sheet", "fictional-profile");
const raw = JSON.parse(readFileSync(new URL("../agent/lib/duty-scheduling/fixtures/sheets-example.json", import.meta.url), "utf8"));
previewDutySheetImport(source, raw);
const { response } = readDutySheetTables(source, raw);
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "source.json"), `${JSON.stringify(source, null, 2)}\n`);
for (const [index, section] of dutySheetSections.entries()) {
  const values = response.valueRanges[index].values;
  const content = values.map((row) => row.map((cell) => {
    const value = String(cell);
    return /[\t\r\n"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join("\t")).join("\n");
  const file = resolve(directory, `${section}.tsv`);
  await writeFile(file, `${content}\n`);
  console.log(`${source.mapping[section].sheet}: ${file}`);
}
console.log(`Настройка источника: ${resolve(directory, "source.json")}`);
