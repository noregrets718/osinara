/** Input boundary tests: ambiguous identities, contradictory dates and editable rules. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseDutyData } from "./duty-data.js";

function example() {
  return parseDutyData(JSON.parse(readFileSync(new URL("./fixtures/example.json", import.meta.url), "utf8")));
}

describe("parseDutyData", () => {
  it("loads the fictional household without inventing missing dates or personal contacts", () => {
    const data = example();
    expect(data.residents).toHaveLength(10);
    expect(data.residents.filter((resident) => resident.workSchedule === "shift")).toHaveLength(8);
    expect(data.workShifts.every((shift) => shift.date === "2026-11-09")).toBe(true);
    expect(data.objects.find((object) => object.id === "dining")).toMatchObject({ people: 2, samePeriod: true });
    expect(data.residents[0]).not.toHaveProperty("phone");
  });

  it("accepts surnames only and different residents with the same surname", () => {
    const data = example();
    const residents = data.residents.map(({ firstName: _firstName, ...resident }) => ({ ...resident, lastName: "Тестов" }));
    expect(parseDutyData({ ...data, residents }).residents[0].firstName).toBeUndefined();
  });

  it("takes supported settings from data rather than fixing the initial values in code", () => {
    const data = example();
    const rules = { ...data.rules, version: "changed-2", lookbackDays: 14, maxAssignmentsPerDay: 2, weekendDays: [5, 6] };
    const objects = data.objects.map((object) => ({ ...object, people: 3, creditPerPerson: 2 }));
    expect(parseDutyData({ ...data, rules, objects })).toMatchObject({ rules, objects });
  });

  it.each(["2026-02-30", "09.11.2026", "2026-11-09T08:00:00Z"])("rejects an invalid calendar date: %s", (date) => {
    const data = example();
    expect(() => parseDutyData({ ...data, workShifts: [{ ...data.workShifts[0], date }] })).toThrow("workShifts.0.date");
  });

  it("accepts a real leap day", () => {
    const data = example();
    expect(parseDutyData({ ...data, workShifts: [{ ...data.workShifts[0], date: "2028-02-29" }] }).workShifts[0].date).toBe("2028-02-29");
  });

  it.each(["residents", "objects"] as const)("rejects duplicate %s IDs", (collection) => {
    const data = example();
    const input = { ...data, [collection]: [...data[collection], data[collection][0]] };
    expect(() => parseDutyData(input)).toThrow(collection);
  });

  it.each(["workShifts", "exceptions"] as const)("rejects %s referring to an unknown resident", (collection) => {
    const data = example();
    const input = { ...data, [collection]: [{ ...data[collection][0], residentId: "unknown" }] };
    expect(() => parseDutyData(input)).toThrow(`${collection}.0.residentId`);
  });

  it("rejects a shift for a resident working five-two", () => {
    const data = example();
    expect(() => parseDutyData({ ...data, workShifts: [{ ...data.workShifts[0], residentId: "r01" }] })).toThrow("Смену можно указать только");
  });

  it.each(["workShifts", "exceptions", "calendarOverrides"] as const)("rejects conflicting entries in %s instead of choosing the last row", (collection) => {
    const data = example();
    const input = { ...data, [collection]: [data[collection][0], data[collection][0]] };
    expect(() => parseDutyData(input)).toThrow(`${collection}.1`);
  });

  it("requires an anchor for alternate-day objects", () => {
    const data = example();
    const object = { ...data.objects[0], recurrence: { everyDays: 2 } };
    expect(() => parseDutyData({ ...data, objects: [object] })).toThrow("objects.0.recurrence.anchorDate");
  });

  it("rejects a departure before arrival", () => {
    const data = example();
    const residents = [{ ...data.residents[0], inactiveFrom: "2026-10-31" }, ...data.residents.slice(1)];
    expect(() => parseDutyData({ ...data, residents })).toThrow("residents.0.inactiveFrom");
  });

  it("rejects an empty availability exception", () => {
    const data = example();
    expect(() => parseDutyData({ ...data, exceptions: [{ residentId: "r01", date: "2026-11-09" }] })).toThrow("Укажите доступность");
  });

  it("does not silently discard unknown rule types", () => {
    const data = example();
    expect(() => parseDutyData({ ...data, rules: { ...data.rules, arbitraryRule: true } })).toThrow("AGENT_DUTY_DATA_INVALID");
  });

  it("requires every availability state, including recovery", () => {
    const data = example();
    const availability = { ...data.rules.availability, shift_recovery: undefined };
    expect(() => parseDutyData({ ...data, rules: { ...data.rules, availability } })).toThrow("rules.availability.shift_recovery");
  });

  it("rejects the text false rather than treating it as a true availability flag", () => {
    const data = example();
    const availability = {
      ...data.rules.availability,
      shift_day: { ...data.rules.availability.shift_day, morning: "false" },
    };
    expect(() => parseDutyData({ ...data, rules: { ...data.rules, availability } })).toThrow("rules.availability.shift_day.morning");
  });

  it("rejects duplicated priority criteria", () => {
    const data = example();
    expect(() => parseDutyData({ ...data, rules: { ...data.rules, priorities: ["least_duties", "least_duties"] } })).toThrow("rules.priorities");
  });

  it("rejects an unknown timezone", () => {
    expect(() => parseDutyData({ ...example(), timezone: "Imaginary/City" })).toThrow("timezone");
  });
});
