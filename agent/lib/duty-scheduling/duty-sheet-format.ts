/** Configurable sheet/column names and strict decoding of row-oriented Sheets values. */
import { z } from "zod";

import { AppError } from "../app-error.js";

const layout = {
  residents: { sheet: "Жильцы", columns: { id: "ID", firstName: "Имя", lastName: "Фамилия", workSchedule: "График", activeFrom: "Заселение", inactiveFrom: "Выезд" } },
  objects: { sheet: "Объекты", columns: { id: "ID", name: "Название", people: "Людей", samePeriod: "Вместе", periods: "Периоды", creditPerPerson: "Зачёт", everyDays: "Каждые дней", anchorDate: "Начало цикла" } },
  workShifts: { sheet: "Смены", columns: { residentId: "ID жильца", date: "Дата", state: "Смена" } },
  calendarOverrides: { sheet: "Календарь", columns: { date: "Дата", isDayOff: "Выходной" } },
  exceptions: { sheet: "Исключения", columns: { residentId: "ID жильца", date: "Дата", morning: "Утро", evening: "Вечер" } },
  settings: { sheet: "Настройки", columns: { key: "Ключ", value: "Значение" } },
  availability: { sheet: "Доступность", columns: { kind: "Тип дня", morning: "Утро", evening: "Вечер" } },
  schedules: { sheet: "Графики", columns: { id: "ID", date: "Дата", version: "Версия", status: "Статус" } },
  assignments: { sheet: "Назначения", columns: { scheduleId: "ID графика", residentId: "ID жильца", objectId: "ID объекта", credit: "Зачёт" } },
};
export type DutySheetSection = keyof typeof layout;
export const dutySheetSections = Object.freeze(Object.keys(layout) as DutySheetSection[]);
const label = z.string().trim().min(1).max(100).refine((value) => !/\p{Cc}/u.test(value));
export const dutySheetSourceSchema = z.object({
  spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
  profileRef: z.string().min(1).max(300),
  mapping: z.record(z.enum(dutySheetSections), z.object({ sheet: label, columns: z.record(z.string(), label) }).strict()),
}).strict();
export type DutySheetSource = z.infer<typeof dutySheetSourceSchema>;
export type DutySheetCell = string | number | boolean;
export type DutySheetRow = { sheet: string; number: number; cells: Record<string, DutySheetCell | undefined> };

export function createDutySheetSource(spreadsheetId: string, profileRef: string): DutySheetSource {
  return parseDutySheetSource({ spreadsheetId, profileRef, mapping: layout });
}

export function parseDutySheetSource(value: unknown): DutySheetSource {
  const parsed = dutySheetSourceSchema.safeParse(value);
  if (!parsed.success) throw sheetError("Некорректная настройка источника или названий столбцов");
  const source = parsed.data;
  const names = new Set<string>();
  for (const section of dutySheetSections) {
    const tab = source.mapping[section];
    const keys = Object.keys(tab.columns).sort((a, b) => a.localeCompare(b));
    const expected = Object.keys(layout[section].columns).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(keys) !== JSON.stringify(expected) || new Set(Object.values(tab.columns)).size !== keys.length) {
      throw sheetError(`Сопоставление столбцов раздела ${section} неполное или содержит повторы`);
    }
    const name = tab.sheet.toLowerCase();
    if (names.has(name)) throw sheetError("Каждому разделу нужен отдельный лист");
    names.add(name);
  }
  return source;
}

export function dutySheetRanges(source: DutySheetSource): string[] {
  return dutySheetSections.map((section) => `'${source.mapping[section].sheet.replaceAll("'", "''")}'!A:Z`);
}

const cell = z.union([z.string().max(10_000), z.number(), z.boolean()]);
const responseSchema = z.object({
  spreadsheetId: z.string(),
  valueRanges: z.array(z.object({
    range: z.string(), majorDimension: z.literal("ROWS"), values: z.array(z.array(cell).max(26)).max(5_001).default([]),
  })).length(dutySheetSections.length),
});

export function readDutySheetTables(source: DutySheetSource, value: unknown) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || parsed.data.spreadsheetId !== source.spreadsheetId) {
    throw sheetError("Ответ таблицы неполный, имеет неверный формат или превышает лимит 5000 строк на лист");
  }
  const tables = {} as Record<DutySheetSection, DutySheetRow[]>;
  dutySheetSections.forEach((section, index) => {
    const tab = source.mapping[section];
    const result = parsed.data.valueRanges[index];
    const separator = result.range.lastIndexOf("!");
    const title = result.range.slice(0, separator);
    const sheet = title.startsWith("'") && title.endsWith("'") ? title.slice(1, -1).replaceAll("''", "'") : title;
    if (separator < 0 || sheet !== tab.sheet || !/^A1:[A-Z][1-9]\d*$/u.test(result.range.slice(separator + 1))) {
      throw sheetError(`Ответ содержит другой лист или диапазон вместо ${tab.sheet}`);
    }
    const [header = [], ...rows] = result.values;
    const headers = header.map((item) => String(item).trim());
    const nonempty = headers.filter(Boolean);
    if (new Set(nonempty).size !== nonempty.length) throw sheetError(`Лист ${tab.sheet}: повторяются заголовки`);
    const columns = Object.entries(tab.columns).map(([key, name]) => {
      const position = headers.indexOf(name);
      if (position < 0) throw sheetError(`Лист ${tab.sheet}: отсутствует столбец ${name}`);
      return { key, position };
    });
    tables[section] = rows.flatMap((row, rowIndex) => {
      const cells = Object.fromEntries(columns.map(({ key, position }) => [key, row[position]]));
      // Extra directory columns do not turn an otherwise empty duty row into a resident.
      if (Object.values(cells).every(blank)) return [];
      return [{ sheet: tab.sheet, number: rowIndex + 2, cells }];
    });
  });
  return { tables, response: parsed.data };
}

function blank(value: DutySheetCell | undefined): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

export function text(row: DutySheetRow, key: string, optional = false): string | undefined {
  const value = row.cells[key];
  if (optional && blank(value)) return undefined;
  if (typeof value !== "string" || !value.trim()) throw cellError(row, key, "нужен непустой текст; ID и даты храните как текст");
  return value.trim();
}
export function integer(row: DutySheetRow, key: string): number {
  const value = row.cells[key];
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value.trim()))) throw cellError(row, key, "нужно целое неотрицательное число");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw cellError(row, key, "нужно целое неотрицательное число");
  return number;
}
export function boolean(row: DutySheetRow, key: string, optional = false): boolean | undefined {
  const value = row.cells[key];
  if (optional && blank(value)) return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "да"].includes(normalized)) return true;
  if (["false", "нет"].includes(normalized)) return false;
  throw cellError(row, key, "нужно Да/Нет или TRUE/FALSE");
}
export function list(row: DutySheetRow, key: string, allowEmpty = false): string[] {
  if (allowEmpty && blank(row.cells[key])) return [];
  if (typeof row.cells[key] === "number") return [String(row.cells[key])];
  return text(row, key)!.split(",").map((part) => part.trim());
}
export function uniqueKeyRows(rows: DutySheetRow[], key: string): Map<string, DutySheetRow> {
  const result = new Map<string, DutySheetRow>();
  for (const row of rows) {
    const value = text(row, key)!;
    if (result.has(value)) throw cellError(row, key, "повторный ключ");
    result.set(value, row);
  }
  return result;
}
export function sheetError(message: string): AppError {
  return new AppError("AGENT_DUTY_SHEET_INVALID", message);
}
function cellError(row: DutySheetRow, key: string, message: string): AppError {
  return sheetError(`Лист ${row.sheet}, строка ${row.number}, поле ${key}: ${message}`);
}
