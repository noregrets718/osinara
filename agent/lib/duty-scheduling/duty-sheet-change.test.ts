/** Cell planning is pure; complete candidate snapshots are validated before forming a write. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { prepareDutySheetChange, planDutySheetWrite, type DutySheetEdit } from "./duty-sheet-change.js";
import { createDutySheetSource } from "./duty-sheet-format.js";

function fixture() {
  const response = JSON.parse(readFileSync(new URL("./fixtures/sheets-example.json", import.meta.url), "utf8"));
  return { response, source: createDutySheetSource("duty-example-sheet", "fixture-profile") };
}
function upsert(section: Extract<DutySheetEdit, { action: "upsert" }>["section"], key: string, values: Record<string, string | number | boolean>): DutySheetEdit {
  return { action: "upsert", section, key, values };
}

describe("prepareDutySheetChange", () => {
  it("changes only the requested mapped cell and keeps extra columns and caller snapshots", () => {
    const f = fixture();
    f.response.valueRanges[0].values[0].push("Телефон");
    f.response.valueRanges[0].values[1].push("fictional-contact");
    const original = structuredClone(f);
    const { plan } = prepareDutySheetChange(f.source, f.response, [upsert("residents", "r01", { lastName: "Изменённая" })]);
    expect(plan.cells).toEqual([{ range: "'Жильцы'!C2", before: "Примерова", after: "Изменённая" }]);
    expect(JSON.parse(plan.argv[7])).toEqual({ valueInputOption: "RAW", data: [{ range: "'Жильцы'!C2", majorDimension: "ROWS", values: [["Изменённая"]] }] });
    expect(f).toEqual(original);
  });

  it("appends an exception with a stable composite key and preserves unspecified periods", () => {
    const f = fixture();
    const { plan } = prepareDutySheetChange(f.source, f.response, [
      upsert("exceptions", "r02/2026-11-09", { residentId: "r02", date: "2026-11-09", morning: false }),
    ]);
    expect(plan.cells.map((cell) => cell.range)).toEqual(["'Исключения'!A3", "'Исключения'!B3", "'Исключения'!C3"]);
    expect(plan.after.data.exceptions[1]).toEqual({ residentId: "r02", date: "2026-11-09", morning: false, evening: undefined });
  });

  it("removes an exception by clearing mapped cells without deleting rows or extra fields", () => {
    const f = fixture();
    f.response.valueRanges[4].values[0].push("Комментарий");
    f.response.valueRanges[4].values[1].push("сохранить");
    const { plan } = prepareDutySheetChange(f.source, f.response, [{ action: "remove", section: "exceptions", key: "r01/2026-11-15" }]);
    expect(plan.after.data.exceptions).toEqual([]);
    expect(plan.cells.every((cell) => cell.after === "")).toBe(true);
    expect(plan.cells.map((cell) => cell.range)).not.toContain("'Исключения'!E2");
  });

  it("creates a deterministic new rules version and includes it in the owner's preview", () => {
    const f = fixture();
    const id = randomUUID();
    const { input, plan } = prepareDutySheetChange(f.source, f.response, [upsert("settings", "lookbackDays", { value: 14 })], id);
    expect(plan.after.data.rules.version).toBe(`rules-${id}`);
    expect(plan.cells).toContainEqual({ range: "'Настройки'!B4", before: "initial-1", after: `rules-${id}` });
    expect(plan.changes).toEqual(expect.arrayContaining([expect.objectContaining({ section: "settings", key: "rulesVersion", kind: "changed" })]));
    expect(planDutySheetWrite(input, f.response)).toEqual(plan);
  });

  it("uses the mapped header positions after column reordering", () => {
    const f = fixture();
    f.response.valueRanges[0].values = f.response.valueRanges[0].values.map((row: unknown[]) => [...row].reverse());
    expect(prepareDutySheetChange(f.source, f.response, [upsert("residents", "r01", { lastName: "Новая" })]).plan.cells[0].range).toBe("'Жильцы'!D2");
  });

  it("stops when a table or row position changed since review", () => {
    const f = fixture();
    const { input } = prepareDutySheetChange(f.source, f.response, [upsert("residents", "r01", { lastName: "Новая" })]);
    f.response.valueRanges[0].values.reverse();
    expect(() => planDutySheetWrite(input, f.response)).toThrow(/AGENT_DUTY_SHEET_(INVALID|CONFLICT)/u);
  });

  it.each([
    [upsert("residents", "r01", { id: "r02" })],
    [upsert("residents", "r01", { privateField: "no" })],
    [upsert("residents", "r01", { lastName: "=NOW()" })],
    [upsert("residents", "r01", { lastName: "" })],
    [upsert("workShifts", "r01/2026-11-09", { residentId: "r01", date: "2026-11-09", state: "off" })],
    [upsert("exceptions", "unknown/2026-11-09", { residentId: "unknown", date: "2026-11-09", morning: false })],
    [upsert("exceptions", "r01/2026-11-15", { morning: "" })],
    [upsert("settings", "lookbackDays", { value: 0 })],
    [upsert("residents", "r01", { lastName: "Примерова" })],
    [upsert("residents", "r01", { lastName: "a" }), upsert("residents", "r01", { lastName: "b" })],
    [{ action: "remove", section: "exceptions", key: "missing" }],
    [{ action: "remove", section: "residents", key: "r01" }],
    [upsert("objects", "dining", { name: "a".repeat(101) })],
  ])("rejects invalid or ambiguous changes: %j", (...edits) => {
    const f = fixture();
    expect(() => prepareDutySheetChange(f.source, f.response, edits as DutySheetEdit[])).toThrow();
  });

  it("rejects a mapped formula and oversized approval batch before any mutation", () => {
    const f = fixture();
    f.response.valueRanges[0].values[1][2] = "=some_formula()";
    expect(() => prepareDutySheetChange(f.source, f.response, [upsert("residents", "r02", { lastName: "Новая" })])).toThrow(/AGENT_DUTY_SHEET_CHANGE_INVALID/u);
    const many = fixture();
    const edits = Array.from({ length: 10 }, (_, index) => upsert("residents", `r${String(index + 1).padStart(2, "0")}`, { lastName: "Ф".repeat(100), firstName: "И".repeat(100) }));
    expect(() => prepareDutySheetChange(many.source, many.response, edits)).toThrow(/AGENT_GOOGLE_WORKSPACE_ARGUMENTS_TOO_LARGE/u);
  });
});
