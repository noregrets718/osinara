/** Validated edits by stable row keys, exact cell previews and bounded RAW writes. No side effects. */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { classifyGoogleWorkspaceCommand } from "../google-workspace/google-workspace-command-policy.js";
import { dutySheetSections, parseDutySheetSource, readDutySheetTables, type DutySheetCell, type DutySheetRow, type DutySheetSection } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";
import { hashDutyJson } from "./duty-snapshot.js";

export const DUTY_SHEET_WRITE_TOOL = "apply_duty_sheet_changes";
export const dutyWritableSectionSchema = z.enum(["residents", "objects", "workShifts", "calendarOverrides", "exceptions", "settings", "availability"]);
const writable = dutyWritableSectionSchema;
const identity = { section: writable, key: z.string().min(1).max(200) };
export const dutySheetEditSchema = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.literal("upsert"), values: z.record(z.string().min(1).max(64), z.union([z.string().max(1000), z.number(), z.boolean()])) }).strict(),
  z.object({ section: z.enum(["workShifts", "calendarOverrides", "exceptions"]), key: identity.key, action: z.literal("remove") }).strict(),
]);
export const dutyWriteBindingSchema = z.object({ groupId: z.uuid(), id: z.uuid(), version: z.number().int().positive() }).strict();
const inputSchema = z.object({ operationId: z.uuid(), source: z.unknown(), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/u), edits: z.array(dutySheetEditSchema).min(1).max(10),
  binding: dutyWriteBindingSchema.optional(), previewId: z.uuid().optional() }).strict();
export type DutySheetEdit = z.infer<typeof dutySheetEditSchema>;
export function parseDutySheetWrite(value: unknown) {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw changeError("Некорректные параметры изменения таблицы");
  return { ...parsed.data, source: parseDutySheetSource(parsed.data.source) };
}
export type DutySheetWriteInput = ReturnType<typeof parseDutySheetWrite>;
export type DutySheetCellChange = { range: string; before: DutySheetCell; after: DutySheetCell };
export type DutySheetWritePlan = ReturnType<typeof planDutySheetWrite>;

export function prepareDutySheetChange(source: unknown, response: unknown, edits: DutySheetEdit[], operationId = randomUUID()) {
  const before = previewDutySheetImport(source, response);
  const input = parseDutySheetWrite({ operationId, source, expectedSourceHash: before.source.contentHash, edits });
  return { input, plan: planDutySheetWrite(input, response) };
}

export function planDutySheetWrite(rawInput: unknown, rawResponse: unknown) {
  const input = parseDutySheetWrite(rawInput);
  const before = previewDutySheetImport(input.source, rawResponse);
  if (before.source.contentHash !== input.expectedSourceHash) throw new AppError("AGENT_DUTY_SHEET_CONFLICT", "Таблица изменилась после предпросмотра. Загрузите её и подтвердите новые правки");
  const original = readDutySheetTables(input.source, rawResponse);
  for (const rows of Object.values(original.tables)) for (const row of rows) {
    if (Object.values(row.cells).some((value) => typeof value === "string" && value.startsWith("="))) {
      throw changeError("Редактирование через агента поддерживается для полей без формул");
    }
  }
  const response = structuredClone(original.response);
  const seen = new Set<string>();
  function apply(edit: DutySheetEdit) {
    const tab = input.source.mapping[edit.section];
    const index = dutySheetSections.indexOf(edit.section);
    const table = readDutySheetTables(input.source, response).tables[edit.section];
    const existing = table.find((row) => dutySheetRowKey(edit.section, row) === edit.key);
    if (!existing && edit.action === "remove") throw changeError("Удаляемое исключение, смена или дата календаря не найдены");
    const rowIndex = existing ? existing.number - 1 : response.valueRanges[index].values.length;
    if (rowIndex > 5000) throw changeError("Достигнут предел 5000 строк на листе");
    const row = response.valueRanges[index].values[rowIndex] ?? [];
    const headers = response.valueRanges[index].values[0].map((value) => String(value).trim());
    const changes = edit.action === "remove" ? Object.fromEntries(Object.keys(tab.columns).map((key) => [key, ""])) : edit.values;
    if (!Object.keys(changes).length) throw changeError("Нужен хотя бы один изменяемый столбец");
    for (const [key, value] of Object.entries(changes)) {
      if (!Object.hasOwn(tab.columns, key)) throw changeError("Передано неизвестное поле строки");
      if (typeof value === "string" && value.startsWith("=")) throw changeError("В изменяемых полях формулы не поддерживаются");
      const column = headers.indexOf(tab.columns[key]);
      while (row.length <= column) row.push("");
      row[column] = value;
    }
    response.valueRanges[index].values[rowIndex] = row;
    if (edit.action === "upsert") {
      const cells = Object.fromEntries(Object.entries(tab.columns).map(([key, name]) => [key, row[headers.indexOf(name)]]));
      if (dutySheetRowKey(edit.section, { sheet: tab.sheet, number: rowIndex + 1, cells }) !== edit.key) throw changeError("Нельзя менять ID или дату строки; для новой записи укажите её постоянный ключ");
    }
  }
  for (const edit of input.edits) {
    const key = `${edit.section}/${edit.key}`;
    if (seen.has(key)) throw changeError("Одна строка указана в правках несколько раз");
    seen.add(key);
    apply(edit);
  }
  let after = previewDutySheetImport(input.source, response, before);
  const rulesContent = (snapshot: typeof before) => ({ timezone: snapshot.data.timezone, objects: snapshot.data.objects, rules: { ...snapshot.data.rules, version: null } });
  if (hashDutyJson(rulesContent(before)) !== hashDutyJson(rulesContent(after)) && before.data.rules.version === after.data.rules.version) {
    apply({ action: "upsert", section: "settings", key: "rulesVersion", values: { value: `rules-${input.operationId}` } });
    after = previewDutySheetImport(input.source, response, before);
  }
  if (!after.changes.length) throw changeError("Правки не меняют данные дежурств");
  const cells: DutySheetCellChange[] = [];
  for (const section of dutySheetSections) {
    const index = dutySheetSections.indexOf(section);
    const tab = input.source.mapping[section];
    const oldRows = original.response.valueRanges[index].values;
    const newRows = response.valueRanges[index].values;
    const headers = newRows[0].map((value) => String(value).trim());
    for (let row = 1; row < newRows.length; row++) for (const name of Object.values(tab.columns)) {
      const column = headers.indexOf(name);
      const oldValue = oldRows[row]?.[column] ?? "";
      const value = newRows[row][column] ?? "";
      if (oldValue !== value) cells.push({ range: `'${tab.sheet.replaceAll("'", "''")}'!${String.fromCharCode(65 + column)}${row + 1}`, before: oldValue, after: value });
    }
  }
  const argv = ["sheets", "spreadsheets", "values", "batchUpdate", "--params", JSON.stringify({ spreadsheetId: input.source.spreadsheetId }), "--json", JSON.stringify({
    valueInputOption: "RAW", data: cells.map((cell) => ({ range: cell.range, majorDimension: "ROWS", values: [[cell.after]] })),
  })];
  classifyGoogleWorkspaceCommand(argv); // Includes the existing approval-size limit; never split an approved batch silently.
  return { cells, changes: after.changes, expectedDataHash: dutySheetDataHash(after), argv, after };
}

export function dutySheetDataHash(value: Pick<ReturnType<typeof previewDutySheetImport>, "data" | "history">): string {
  return hashDutyJson({ data: value.data, history: value.history });
}
export function dutySheetRowKey(section: DutySheetSection, row: DutySheetRow): string {
  const cells = row.cells;
  const value = (key: string) => String(cells[key] ?? "").trim();
  if (section === "residents" || section === "objects") return value("id");
  if (section === "workShifts" || section === "exceptions") return `${value("residentId")}/${value("date")}`;
  if (section === "settings") return value("key");
  if (section === "availability") return value("kind");
  return value("date");
}
function changeError(message: string): AppError { return new AppError("AGENT_DUTY_SHEET_CHANGE_INVALID", message); }
