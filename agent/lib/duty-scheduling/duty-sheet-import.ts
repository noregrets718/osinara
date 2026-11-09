/** Convert a complete table read into validated snapshots and a reviewable, non-persisting diff. */
import { parseDutyData, type DutyData } from "./duty-data.js";
import { parseDutyHistory, type DutyHistory } from "./duty-history.js";
import { boolean, integer, list, parseDutySheetSource, readDutySheetTables, sheetError, text, uniqueKeyRows, type DutySheetRow } from "./duty-sheet-format.js";
import { hashDutyJson } from "./duty-snapshot.js";

export type DutySheetBaseline = { data: DutyData; history: DutyHistory };
export type DutySheetChange = { section: string; key: string; kind: "added" | "changed" | "removed"; before?: unknown; after?: unknown };

export function previewDutySheetImport(rawSource: unknown, rawResponse: unknown, previous?: DutySheetBaseline) {
  const source = parseDutySheetSource(rawSource);
  const { tables, response } = readDutySheetTables(source, rawResponse);
  const settings = uniqueKeyRows(tables.settings, "key");
  const expected = ["schemaVersion", "timezone", "rulesVersion", "weekendDays", "maxAssignmentsPerDay", "lookbackDays", "priorities", "allowIncompleteSchedules", "historyMode", "historyFromDate"];
  if (settings.size !== expected.length || expected.some((key) => !settings.has(key))) throw sheetError("Лист настроек должен содержать все поддерживаемые ключи без неизвестных настроек");
  function setting(key: string): DutySheetRow { return settings.get(key)!; }
  const availability = uniqueKeyRows(tables.availability, "kind");
  const data = parseDutyData({
    schemaVersion: integer(setting("schemaVersion"), "value"), timezone: text(setting("timezone"), "value"),
    residents: tables.residents.map((row) => ({ id: text(row, "id"), firstName: text(row, "firstName", true), lastName: text(row, "lastName"),
      workSchedule: text(row, "workSchedule"), activeFrom: text(row, "activeFrom"), inactiveFrom: text(row, "inactiveFrom", true) })),
    objects: tables.objects.map((row) => ({ id: text(row, "id"), name: text(row, "name"), people: integer(row, "people"), samePeriod: boolean(row, "samePeriod"),
      periods: list(row, "periods"), creditPerPerson: integer(row, "creditPerPerson"), recurrence: { everyDays: integer(row, "everyDays"), anchorDate: text(row, "anchorDate", true) } })),
    workShifts: tables.workShifts.map((row) => ({ residentId: text(row, "residentId"), date: text(row, "date"), state: text(row, "state") })),
    calendarOverrides: tables.calendarOverrides.map((row) => ({ date: text(row, "date"), isDayOff: boolean(row, "isDayOff") })),
    exceptions: tables.exceptions.map((row) => ({ residentId: text(row, "residentId"), date: text(row, "date"), morning: boolean(row, "morning", true), evening: boolean(row, "evening", true) })),
    rules: {
      version: text(setting("rulesVersion"), "value"), weekendDays: list(setting("weekendDays"), "value", true).map(Number),
      availability: Object.fromEntries([...availability].map(([kind, row]) => [kind, { morning: boolean(row, "morning"), evening: boolean(row, "evening") }])),
      maxAssignmentsPerDay: integer(setting("maxAssignmentsPerDay"), "value"), lookbackDays: integer(setting("lookbackDays"), "value"),
      priorities: list(setting("priorities"), "value"), allowIncompleteSchedules: boolean(setting("allowIncompleteSchedules"), "value"),
    },
  });
  const schedules = uniqueKeyRows(tables.schedules, "id");
  const assignments = new Map<string, { residentId: string; objectId: string; credit: number }[]>();
  for (const row of tables.assignments) {
    const id = text(row, "scheduleId")!;
    if (!schedules.has(id)) throw sheetError(`Лист ${row.sheet}, строка ${row.number}: ID графика отсутствует в листе графиков`);
    const values = assignments.get(id) ?? [];
    values.push({ residentId: text(row, "residentId")!, objectId: text(row, "objectId")!, credit: integer(row, "credit") });
    assignments.set(id, values);
  }
  const mode = text(setting("historyMode"), "value");
  const fromDate = text(setting("historyFromDate"), "value", true);
  if (mode === "not_loaded" && (schedules.size || fromDate !== undefined)) throw sheetError("Для not_loaded очистите дату начала истории и строки прошлых графиков");
  const history = parseDutyHistory(mode === "not_loaded" ? { mode } : { mode, fromDate, schedules: [...schedules].map(([id, row]) => ({
    id, date: text(row, "date"), version: integer(row, "version"), status: text(row, "status"), assignments: assignments.get(id) ?? [],
  })) }, data);
  let baseline: DutySheetBaseline | undefined;
  if (previous) {
    const oldData = parseDutyData(previous.data);
    baseline = { data: oldData, history: parseDutyHistory(previous.history, oldData) };
  }
  return {
    data, history, source: { ...source, contentHash: hashDutyJson({ source, response }) },
    rows: Object.entries(tables).flatMap(([section, rows]) => rows.map((row) => ({ section, sheet: row.sheet, row: row.number, contentHash: hashDutyJson(row.cells) }))),
    changes: compareSnapshots(baseline, { data, history }),
    counts: { residents: data.residents.length, objects: data.objects.length, workShifts: data.workShifts.length,
      schedules: history.mode === "not_loaded" ? 0 : history.schedules.length, assignments: tables.assignments.length },
  };
}

function compareSnapshots(before: DutySheetBaseline | undefined, after: DutySheetBaseline): DutySheetChange[] {
  const changes: DutySheetChange[] = [];
  function compare(section: string, oldRows: Map<string, unknown>, newRows: Map<string, unknown>) {
    const keys = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      const oldValue = oldRows.get(key);
      const newValue = newRows.get(key);
      if (oldRows.has(key) && newRows.has(key) && hashDutyJson(oldValue) === hashDutyJson(newValue)) continue;
      changes.push({ section, key, kind: !newRows.has(key) ? "removed" : !oldRows.has(key) ? "added" : "changed", before: oldValue, after: newValue });
    }
  }
  for (const section of ["residents", "objects", "workShifts", "exceptions", "calendarOverrides"] as const) {
    const rows = (snapshot: DutySheetBaseline | undefined) => new Map((snapshot?.data[section] ?? []).map((row) => [
      "id" in row ? row.id : "residentId" in row ? `${row.residentId}/${row.date}` : row.date, row,
    ]));
    compare(section, rows(before), rows(after));
  }
  const settings = (snapshot: DutySheetBaseline | undefined) => new Map<string, unknown>(snapshot ? [
    ["schemaVersion", snapshot.data.schemaVersion], ["timezone", snapshot.data.timezone], ["rulesVersion", snapshot.data.rules.version],
    ...Object.entries(snapshot.data.rules).filter(([key]) => key !== "version" && key !== "availability"),
    ["historyMode", snapshot.history.mode], ["historyFromDate", snapshot.history.mode === "not_loaded" ? null : snapshot.history.fromDate],
  ] : []);
  compare("settings", settings(before), settings(after));
  const availability = (snapshot: DutySheetBaseline | undefined) => new Map(snapshot ? Object.entries(snapshot.data.rules.availability) : []);
  compare("availability", availability(before), availability(after));
  const schedules = (snapshot: DutySheetBaseline | undefined) => new Map(snapshot && snapshot.history.mode !== "not_loaded" ? snapshot.history.schedules.map((row) => [row.id, {
    ...row, assignments: [...row.assignments].sort((a, b) => `${a.residentId}/${a.objectId}`.localeCompare(`${b.residentId}/${b.objectId}`)),
  }]) : []);
  compare("schedules", schedules(before), schedules(after));
  return changes;
}
