/** History integrity: one effective approved version and explicit accounting baseline. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseDutyData } from "./duty-data.js";
import { parseDutyHistory } from "./duty-history.js";

function data() {
  return parseDutyData(JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/example.json", import.meta.url), "utf8")));
}

function schedule() {
  return { id: "s1", date: "2026-11-02", version: 1, status: "approved", assignments: [{ residentId: "r01", objectId: "dining", credit: 1 }] };
}

function parse(schedules: unknown[]) {
  return parseDutyHistory({ mode: "imported", fromDate: "2026-10-01", schedules }, data());
}

describe("parseDutyHistory", () => {
  it("loads the fictional history including archived and draft versions", () => {
    const history = parseDutyHistory(JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/history.json", import.meta.url), "utf8")), data());
    if (history.mode === "not_loaded") throw new Error("Expected imported history");
    expect(history.schedules).toHaveLength(5);
    expect(history.schedules.filter((item) => item.status === "approved")).toHaveLength(2);
  });

  it("keeps not_loaded distinct from an empty confirmed baseline", () => {
    expect(parseDutyHistory({ mode: "not_loaded" }, data())).toEqual({ mode: "not_loaded" });
    expect(parseDutyHistory({ mode: "zero_start", fromDate: "2026-11-09", schedules: [] }, data())).toEqual({
      mode: "zero_start", fromDate: "2026-11-09", schedules: [],
    });
  });

  it.each([undefined, {}, { mode: "zero_start", schedules: [] }, { mode: "imported", fromDate: "2026-02-30", schedules: [] }])("rejects missing/invalid accounting information: %j", (input) => {
    expect(() => parseDutyHistory(input, data())).toThrow("AGENT_DUTY_HISTORY_INVALID");
  });

  it.each(["residentId", "objectId"])("rejects an unknown %s in any assignment", (field) => {
    const item = schedule();
    expect(() => parse([{ ...item, assignments: [{ ...item.assignments[0], [field]: "unknown" }] }])).toThrow(field);
  });

  it("rejects two active approved versions on one date", () => {
    const first = schedule();
    expect(() => parse([first, { ...first, id: "s2", version: 2 }])).toThrow("только одна утверждённая версия");
  });

  it("rejects a repeated version even when the second row is cancelled", () => {
    const first = schedule();
    expect(() => parse([first, { ...first, id: "s2", status: "cancelled" }])).toThrow("повторная версия");
  });

  it("rejects the same schedule ID on different dates", () => {
    const first = schedule();
    expect(() => parse([first, { ...first, date: "2026-11-03" }])).toThrow("повторный ID");
  });

  it("rejects a duplicate assignment instead of doubling workload", () => {
    const item = schedule();
    expect(() => parse([{ ...item, assignments: [item.assignments[0], item.assignments[0]] }])).toThrow("повторное назначение");
  });

  it("accepts two different residents sharing the dining object", () => {
    const item = schedule();
    expect(() => parse([{ ...item, assignments: [item.assignments[0], { ...item.assignments[0], residentId: "r02" }] }])).not.toThrow();
  });

  it("does not apply today's daily assignment limit retroactively to earlier rules", () => {
    const item = schedule();
    expect(() => parse([{ ...item, assignments: [item.assignments[0], { ...item.assignments[0], objectId: "laundry" }] }])).not.toThrow();
  });

  it("requires the baseline to include the supplied records", () => {
    expect(() => parseDutyHistory({ mode: "zero_start", fromDate: "2026-11-03", schedules: [schedule()] }, data())).toThrow("раньше начала учёта");
  });
});
