/** Cleaning recurrence boundaries, calendar arithmetic and intact executor groups. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseDutyData } from "./duty-data.js";
import { getDutyObjectsForDate } from "./duty-day-objects.js";

function example() {
  return parseDutyData(JSON.parse(readFileSync(new URL("./fixtures/example.json", import.meta.url), "utf8")));
}

describe("getDutyObjectsForDate", () => {
  it.each([
    ["2026-11-09", "floor-2"],
    ["2026-11-10", "floor-3"],
    ["2026-11-11", "floor-2"],
  ])("selects the alternating floor on %s", (date, floor) => {
    const result = getDutyObjectsForDate(example().objects, date);
    expect(result.objects.map((object) => object.objectId)).toEqual(["dining", "floor-1", floor, "laundry", "administration"]);
    expect(result.requiredSlots).toBe(6);
  });

  it("retains dining as one simultaneous two-person group", () => {
    const result = getDutyObjectsForDate(example().objects, "2026-11-09");
    expect(result.objects).toHaveLength(5);
    expect(result.objects.find((object) => object.objectId === "dining")).toEqual({
      objectId: "dining", name: "Столовая", people: 2, samePeriod: true,
      periods: ["morning", "evening"], creditPerPerson: 1,
    });
  });

  it("allows both floors on the same date if their configured cycles coincide", () => {
    const data = example();
    data.objects[3].recurrence.anchorDate = "2026-11-09";
    const result = getDutyObjectsForDate(data.objects, "2026-11-09");
    expect(result.objects.map((object) => object.objectId)).toContain("floor-2");
    expect(result.objects.map((object) => object.objectId)).toContain("floor-3");
    expect(result.requiredSlots).toBe(7);
  });

  it.each(["2026-01-01", "2026-11-09", "2027-01-01"])("keeps daily objects without an anchor on %s", (date) => {
    const result = getDutyObjectsForDate([example().objects[0]], date);
    expect(result.objects.map((object) => object.objectId)).toEqual(["dining"]);
    expect(result.requiredSlots).toBe(2);
  });

  it.each([
    ["2026-11-07", false], ["2026-11-08", false], ["2026-11-09", true],
    ["2026-11-10", false], ["2026-11-11", true],
  ])("starts a cycle at its anchor, not backwards: %s", (date, due) => {
    const result = getDutyObjectsForDate([example().objects[2]], date);
    expect(result.objects.length > 0).toBe(due);
    expect(result.date).toBe(date);
  });

  it.each([
    ["2026-11-08", false], ["2026-11-09", true], ["2026-11-10", true],
  ])("respects an optional start date for a daily object: %s", (date, due) => {
    const object = { ...example().objects[0], recurrence: { everyDays: 1, anchorDate: "2026-11-09" } };
    expect(getDutyObjectsForDate([object], date).objects.length > 0).toBe(due);
  });

  it("uses a configurable interval rather than fixing every recurrence at two days", () => {
    const object = { ...example().objects[2], recurrence: { everyDays: 3, anchorDate: "2026-11-09" } };
    expect(getDutyObjectsForDate([object], "2026-11-11").requiredSlots).toBe(0);
    expect(getDutyObjectsForDate([object], "2026-11-12").requiredSlots).toBe(1);
    expect(getDutyObjectsForDate([object], "2026-11-15").requiredSlots).toBe(1);
  });

  it.each([
    ["2028-02-28", true], ["2028-02-29", false], ["2028-03-01", true],
    ["2028-03-02", false], ["2028-03-03", true],
  ])("counts actual calendar days across leap day: %s", (date, due) => {
    const object = { ...example().objects[2], recurrence: { everyDays: 2, anchorDate: "2028-02-28" } };
    expect(getDutyObjectsForDate([object], date).objects.length > 0).toBe(due);
  });

  it.each([
    ["2026-11-30", "2026-12-01", false], ["2026-11-30", "2026-12-02", true],
    ["2026-12-31", "2027-01-01", false], ["2026-12-31", "2027-01-02", true],
  ])("counts days across a month/year boundary from %s to %s", (anchorDate, date, due) => {
    const object = { ...example().objects[2], recurrence: { everyDays: 2, anchorDate } };
    expect(getDutyObjectsForDate([object], date).objects.length > 0).toBe(due);
  });

  it("returns zero requirements if no object is due", () => {
    expect(getDutyObjectsForDate([example().objects[2]], "2026-11-10")).toEqual({
      date: "2026-11-10", objects: [], requiredSlots: 0,
    });
  });

  it("keeps editable group size, periods and per-person credit", () => {
    const object = { ...example().objects[0], people: 3, samePeriod: false, creditPerPerson: 2 };
    const data = parseDutyData({ ...example(), objects: [{ ...object, periods: ["evening"] }] });
    expect(getDutyObjectsForDate(data.objects, "2026-11-09")).toEqual({
      date: "2026-11-09", requiredSlots: 3,
      objects: [{ objectId: "dining", name: "Столовая", people: 3, samePeriod: false, periods: ["evening"], creditPerPerson: 2 }],
    });
  });

  it("keeps input definitions unchanged and returns a detached periods array", () => {
    const data = example();
    const before = structuredClone(data.objects);
    const result = getDutyObjectsForDate(data.objects, "2026-11-09");
    expect(data.objects).toEqual(before);
    expect(result.objects[0].periods).not.toBe(data.objects[0].periods);
  });

  it("reports a missing recurrence anchor instead of silently skipping the object", () => {
    const object = { ...example().objects[2], recurrence: { everyDays: 2 } };
    expect(() => getDutyObjectsForDate([object], "2026-11-09")).toThrow("AGENT_DUTY_RECURRENCE_INVALID");
  });

  it.each(["2026-02-30", "09.11.2026", "2026-11-09T08:00:00Z"])("rejects an invalid query date: %s", (date) => {
    expect(() => getDutyObjectsForDate(example().objects, date)).toThrow("AGENT_DUTY_DATE_INVALID");
  });
});
