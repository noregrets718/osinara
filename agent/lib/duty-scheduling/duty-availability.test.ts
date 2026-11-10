/** Availability matrix, owner overrides, missing information and residency boundaries. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getDutyAvailability, type DutyAvailability } from "./duty-availability.js";
import { parseDutyData, type DutyShiftState } from "./duty-data.js";

function example() {
  return parseDutyData(JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/example.json", import.meta.url), "utf8")));
}

const matrix: {
  label: string; residentId: string; date: string; shift?: DutyShiftState;
  morning: boolean; evening: boolean; basis: DutyAvailability["basis"];
}[] = [
  { label: "five-two workday", residentId: "r01", date: "2026-11-09", morning: false, evening: true, basis: "five_two_workday" },
  { label: "five-two day off", residentId: "r01", date: "2026-11-15", morning: true, evening: true, basis: "five_two_day_off" },
  { label: "day shift", residentId: "r03", date: "2026-11-09", shift: "day", morning: false, evening: false, basis: "shift_day" },
  { label: "night shift", residentId: "r03", date: "2026-11-09", shift: "night", morning: true, evening: false, basis: "shift_night" },
  { label: "recovery", residentId: "r03", date: "2026-11-09", shift: "recovery", morning: false, evening: true, basis: "shift_recovery" },
  { label: "shift off on a workday", residentId: "r03", date: "2026-11-09", shift: "off", morning: false, evening: true, basis: "shift_off_workday" },
  { label: "shift off on a day off", residentId: "r03", date: "2026-11-15", shift: "off", morning: true, evening: true, basis: "shift_off_day_off" },
];

describe("getDutyAvailability", () => {
  it.each(matrix)("applies the agreed matrix: $label", (row) => {
    const data = example();
    data.calendarOverrides = [];
    data.exceptions = [];
    data.workShifts = row.shift ? [{ residentId: row.residentId, date: row.date, state: row.shift }] : [];
    expect(getDutyAvailability(data, row.residentId, row.date)).toEqual({
      residentId: row.residentId, date: row.date, morning: row.morning,
      evening: row.evening, basis: row.basis, exceptionApplied: false,
    });
  });

  it("uses an explicit working Saturday instead of the usual weekend", () => {
    expect(getDutyAvailability(example(), "r01", "2026-11-14")).toMatchObject({
      morning: false, evening: true, basis: "five_two_workday",
    });
  });

  it("uses a weekday holiday for both five-two and a shift worker's day off", () => {
    const data = example();
    data.calendarOverrides = [{ date: "2026-11-09", isDayOff: true }];
    expect(getDutyAvailability(data, "r01", "2026-11-09")).toMatchObject({ morning: true, evening: true, basis: "five_two_day_off" });
    expect(getDutyAvailability(data, "r06", "2026-11-09")).toMatchObject({ morning: true, evening: true, basis: "shift_off_day_off" });
  });

  it("uses the workday override for a shift worker's day off", () => {
    const data = example();
    data.workShifts = [{ residentId: "r03", date: "2026-11-14", state: "off" }];
    expect(getDutyAvailability(data, "r03", "2026-11-14")).toMatchObject({ morning: false, evening: true, basis: "shift_off_workday" });
  });

  it("takes weekend days and availability from editable rules", () => {
    const data = example();
    data.rules.weekendDays = [1];
    data.rules.availability.five_two_day_off = { morning: false, evening: false };
    expect(getDutyAvailability(data, "r01", "2026-11-09")).toMatchObject({ morning: false, evening: false, basis: "five_two_day_off" });
    data.rules.availability.shift_night = { morning: false, evening: true };
    expect(getDutyAvailability(data, "r04", "2026-11-09")).toMatchObject({ morning: false, evening: true, basis: "shift_night" });
  });

  it("applies a morning-only exception while preserving the normal evening", () => {
    expect(getDutyAvailability(example(), "r01", "2026-11-15")).toMatchObject({
      morning: false, evening: true, basis: "five_two_day_off", exceptionApplied: true,
    });
  });

  it("preserves explicit false for both periods", () => {
    const data = example();
    data.exceptions = [{ residentId: "r01", date: "2026-11-15", morning: false, evening: false }];
    expect(getDutyAvailability(data, "r01", "2026-11-15")).toMatchObject({ morning: false, evening: false, exceptionApplied: true });
  });

  it("allows an owner exception to change the evening without changing the morning", () => {
    const data = example();
    data.exceptions = [{ residentId: "r04", date: "2026-11-09", evening: true }];
    expect(getDutyAvailability(data, "r04", "2026-11-09")).toMatchObject({ morning: true, evening: true, exceptionApplied: true });
  });

  it("does not apply another resident's or another date's exception", () => {
    const data = example();
    expect(getDutyAvailability(data, "r02", "2026-11-15")).toMatchObject({ morning: true, evening: true, exceptionApplied: false });
    expect(getDutyAvailability(data, "r01", "2026-11-21")).toMatchObject({ morning: true, evening: true, exceptionApplied: false });
  });

  it("does not invent a missing shift or replace it with an availability exception", () => {
    const data = example();
    data.exceptions = [{ residentId: "r03", date: "2026-11-10", morning: true, evening: true }];
    expect(getDutyAvailability(data, "r03", "2026-11-10")).toEqual({
      residentId: "r03", date: "2026-11-10", morning: false, evening: false,
      basis: "missing_shift", exceptionApplied: false,
    });
  });

  it("includes the arrival date but excludes earlier days even with an exception", () => {
    const data = example();
    data.exceptions = [{ residentId: "r01", date: "2026-10-31", morning: true }];
    expect(getDutyAvailability(data, "r01", "2026-11-01")).toMatchObject({ morning: true, evening: true, basis: "five_two_day_off" });
    expect(getDutyAvailability(data, "r01", "2026-10-31")).toMatchObject({ morning: false, evening: false, basis: "not_yet_resident", exceptionApplied: false });
  });

  it("excludes the departure date and later but still calculates the preceding day", () => {
    const data = example();
    data.residents[0].inactiveFrom = "2026-11-10";
    data.exceptions = [{ residentId: "r01", date: "2026-11-10", morning: true, evening: true }];
    expect(getDutyAvailability(data, "r01", "2026-11-09")).toMatchObject({ evening: true, basis: "five_two_workday" });
    for (const date of ["2026-11-10", "2026-11-11"]) {
      expect(getDutyAvailability(data, "r01", date)).toMatchObject({ morning: false, evening: false, basis: "departed", exceptionApplied: false });
    }
  });

  it.each(["Pacific/Kiritimati", "Pacific/Pago_Pago"])("keeps the requested calendar day in timezone %s", (timezone) => {
    const data = example();
    data.timezone = timezone;
    expect(getDutyAvailability(data, "r01", "2026-11-09")).toMatchObject({ morning: false, evening: true, basis: "five_two_workday" });
  });

  it("does not mutate the input snapshot or its availability matrix", () => {
    const data = example();
    const before = structuredClone(data);
    getDutyAvailability(data, "r01", "2026-11-15");
    expect(data).toEqual(before);
  });

  it("reports an unknown resident instead of presenting it as unavailability", () => {
    expect(() => getDutyAvailability(example(), "unknown", "2026-11-09")).toThrow("AGENT_DUTY_RESIDENT_NOT_FOUND");
  });

  it.each(["2026-02-30", "09.11.2026", "2026-11-09T08:00:00Z"])("rejects an invalid requested date: %s", (date) => {
    expect(() => getDutyAvailability(example(), "r01", date)).toThrow("AGENT_DUTY_DATE_INVALID");
  });
});
