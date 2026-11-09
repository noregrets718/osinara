/** Table-shaped fictional fixtures exercise parsing, domain validation and stable-ID previews. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { prepareDutyDraft } from "./duty-allocation.js";
import { createDutySheetSource, dutySheetRanges, parseDutySheetSource, type DutySheetCell } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";

function json(name: string) { return JSON.parse(readFileSync(new URL(`../../../examples/duty-scheduling/${name}.json`, import.meta.url), "utf8")); }
type Response = { spreadsheetId: string; valueRanges: { range: string; majorDimension: string; values: DutySheetCell[][] }[] };
function response(): Response { return json("sheets-example"); }
function source() { return createDutySheetSource("duty-example-sheet", "fictional-profile"); }
function setting(input: Response, key: string, value: DutySheetCell) {
  const row = input.valueRanges[5].values.find((row) => row[0] === key);
  if (!row) throw new Error("Missing fixture setting");
  row[1] = value;
}

describe("previewDutySheetImport", () => {
  it("loads the complete fictional table and feeds the existing allocation unchanged", () => {
    const result = previewDutySheetImport(source(), response());
    expect(result.data).toEqual(json("example"));
    expect(result.history).toEqual(json("history"));
    expect(result.counts).toEqual({ residents: 10, objects: 6, workShifts: 8, schedules: 5, assignments: 12 });
    expect(prepareDutyDraft(result.data, result.history, "2026-11-09")).toMatchObject({ filledSlots: 6, complete: true });
    expect(result.changes.every((row) => row.kind === "added")).toBe(true);
  });

  it("detects additions, edits and removal by ID and preserves caller inputs", () => {
    const raw = response();
    const first = previewDutySheetImport(source(), raw);
    raw.valueRanges[0].values[1][2] = "НоваяФамилия";
    raw.valueRanges[0].values.push(["r11", "", "Дополнительный", "five_two", "2026-11-01", ""]);
    raw.valueRanges[4].values.pop();
    setting(raw, "lookbackDays", 14);
    const copy = structuredClone({ raw, first });
    const next = previewDutySheetImport(source(), raw, first);
    expect(next.changes.map(({ section, key, kind }) => ({ section, key, kind }))).toEqual([
      { section: "residents", key: "r01", kind: "changed" }, { section: "residents", key: "r11", kind: "added" },
      { section: "exceptions", key: "r01/2026-11-15", kind: "removed" }, { section: "settings", key: "lookbackDays", kind: "changed" },
    ]);
    expect(next.changes[0]).toMatchObject({ before: { lastName: "Примерова" }, after: { lastName: "НоваяФамилия" } });
    expect(next.source.contentHash).not.toBe(first.source.contentHash);
    expect({ raw, first }).toEqual(copy);
  });

  it("compares semantically despite reordered data rows, headers and history assignments", () => {
    const raw = response();
    const baseline = previewDutySheetImport(source(), raw);
    for (const tab of raw.valueRanges) {
      const [header, ...rows] = tab.values;
      tab.values = [header, ...rows.reverse()].map((row) => [...row].reverse());
    }
    const result = previewDutySheetImport(source(), raw, baseline);
    expect(result.changes).toEqual([]);
    expect(result.source.contentHash).not.toBe(baseline.source.contentHash);
  });

  it("supports renamed sheets and mapped headers, including quoted sheet titles", () => {
    const config = source();
    const raw = response();
    config.mapping.residents.sheet = "Жильцы O'Брайена!";
    config.mapping.residents.columns.lastName = "Фамилия человека";
    raw.valueRanges[0].range = "'Жильцы O''Брайена!'!A1:Z1000";
    raw.valueRanges[0].values[0][2] = "Фамилия человека";
    expect(dutySheetRanges(config)[0]).toBe("'Жильцы O''Брайена!'!A:Z");
    expect(previewDutySheetImport(config, raw).data.residents).toEqual(json("example").residents);
  });

  it("handles trimmed text, optional cells, native booleans, text booleans and text integers", () => {
    const raw = response();
    raw.valueRanges[0].values[1][1] = "  Анна  ";
    raw.valueRanges[1].values[1][2] = "2";
    raw.valueRanges[1].values[1][3] = "Да";
    raw.valueRanges[4].values[1][2] = "Нет";
    raw.valueRanges[0].values.splice(2, 0, []);
    setting(raw, "weekendDays", 6);
    const result = previewDutySheetImport(source(), raw);
    expect(result.data.residents[0].firstName).toBe("Анна");
    expect(result.data.exceptions[0]).toEqual({ residentId: "r01", date: "2026-11-15", morning: false, evening: undefined });
    expect(result.data.rules.weekendDays).toEqual([6]);
    expect(result.rows.find((row) => row.section === "residents" && row.row === 4)).toBeDefined();
  });

  it("ignores additional directory columns in duty data but includes their changes in the source hash", () => {
    const raw = response();
    const baseline = previewDutySheetImport(source(), raw);
    raw.valueRanges[0].values[0].push("Телефон");
    raw.valueRanges[0].values[1].push("Вымышленный контакт");
    const next = previewDutySheetImport(source(), raw, baseline);
    expect(next.changes).toEqual([]);
    expect(next.data).toEqual(baseline.data);
    expect(next.source.contentHash).not.toBe(baseline.source.contentHash);
  });

  it.each([
    ["missing header", (raw: Response) => { raw.valueRanges[0].values[0][2] = "Ошибка"; }],
    ["duplicate header", (raw: Response) => { raw.valueRanges[0].values[0][2] = "Имя"; }],
    ["numeric resident ID", (raw: Response) => { raw.valueRanges[0].values[1][0] = 1; }],
    ["serial date", (raw: Response) => { raw.valueRanges[0].values[1][4] = 46000; }],
    ["localized date", (raw: Response) => { raw.valueRanges[0].values[1][4] = "01.11.2026"; }],
    ["duplicate resident", (raw: Response) => { raw.valueRanges[0].values.push(raw.valueRanges[0].values[1]); }],
    ["duplicate shift", (raw: Response) => { raw.valueRanges[2].values.push(raw.valueRanges[2].values[1]); }],
    ["missing resident", (raw: Response) => { raw.valueRanges[2].values[1][0] = "unknown"; }],
    ["unknown graph", (raw: Response) => { raw.valueRanges[8].values[1][0] = "unknown"; }],
    ["duplicate setting", (raw: Response) => { raw.valueRanges[5].values.push(raw.valueRanges[5].values[1]); }],
    ["unknown setting", (raw: Response) => { raw.valueRanges[5].values.push(["typo", "value"]); }],
    ["missing setting", (raw: Response) => { raw.valueRanges[5].values.pop(); }],
    ["unknown availability", (raw: Response) => { raw.valueRanges[6].values[1][0] = "unknown"; }],
    ["duplicate availability", (raw: Response) => { raw.valueRanges[6].values.push(raw.valueRanges[6].values[1]); }],
    ["missing availability", (raw: Response) => { raw.valueRanges[6].values.pop(); }],
    ["numeric boolean", (raw: Response) => { raw.valueRanges[1].values[1][3] = 1; }],
    ["fractional team", (raw: Response) => { raw.valueRanges[1].values[1][2] = 1.5; }],
    ["negative credit", (raw: Response) => { raw.valueRanges[8].values[1][3] = -1; }],
    ["empty exception", (raw: Response) => { raw.valueRanges[4].values[1][2] = ""; }],
    ["different sheet", (raw: Response) => { raw.valueRanges[0].range = "'Иная таблица'!A1:Z1000"; }],
    ["offset range", (raw: Response) => { raw.valueRanges[0].range = "'Жильцы'!A2:Z1000"; }],
    ["missing range", (raw: Response) => { raw.valueRanges.pop(); }],
    ["wrong spreadsheet", (raw: Response) => { raw.spreadsheetId = "another-sheet"; }],
    ["column-oriented response", (raw: Response) => { raw.valueRanges[0].majorDimension = "COLUMNS"; }],
    ["oversized sheet", (raw: Response) => { raw.valueRanges[0].values = Array.from({ length: 5002 }, () => []); }],
  ])("rejects %s", (_label, change) => {
    const raw = response();
    change(raw);
    expect(() => previewDutySheetImport(source(), raw)).toThrow(/AGENT_DUTY_(SHEET|DATA|HISTORY)_INVALID/u);
  });

  it("requires an explicit history mode and never silently substitutes zero_start", () => {
    const raw = response();
    setting(raw, "historyMode", "not_loaded");
    expect(() => previewDutySheetImport(source(), raw)).toThrow(/AGENT_DUTY_SHEET_INVALID/u);
    raw.valueRanges[7].values.splice(1);
    raw.valueRanges[8].values.splice(1);
    setting(raw, "historyFromDate", "");
    expect(previewDutySheetImport(source(), raw).history).toEqual({ mode: "not_loaded" });
    setting(raw, "historyMode", "zero_start");
    expect(() => previewDutySheetImport(source(), raw)).toThrow(/AGENT_DUTY_HISTORY_INVALID/u);
    setting(raw, "historyFromDate", "2026-11-01");
    expect(previewDutySheetImport(source(), raw).history).toEqual({ mode: "zero_start", fromDate: "2026-11-01", schedules: [] });
  });

  it("shows assignment edits and keeps empty historical schedules", () => {
    const raw = response();
    const baseline = previewDutySheetImport(source(), raw);
    raw.valueRanges[8].values[1][3] = 2;
    expect(previewDutySheetImport(source(), raw, baseline).changes).toMatchObject([{ section: "schedules", key: "nov-02-v1", kind: "changed" }]);
    raw.valueRanges[8].values.splice(1);
    const next = previewDutySheetImport(source(), raw);
    if (next.history.mode === "not_loaded") throw new Error("Expected history");
    expect(next.history.schedules).toHaveLength(5);
    expect(next.history.schedules.every((row) => row.assignments.length === 0)).toBe(true);
  });

  it("rejects ambiguous mappings and arbitrary spreadsheet URLs", () => {
    const config = source();
    config.mapping.objects.sheet = config.mapping.residents.sheet;
    expect(() => parseDutySheetSource(config)).toThrow(/AGENT_DUTY_SHEET_INVALID/u);
    const duplicate = source();
    duplicate.mapping.residents.columns.id = "Имя";
    expect(() => parseDutySheetSource(duplicate)).toThrow(/AGENT_DUTY_SHEET_INVALID/u);
    expect(() => createDutySheetSource("https://example.com", "profile")).toThrow(/AGENT_DUTY_SHEET_INVALID/u);
  });
});
