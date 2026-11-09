/** Window boundaries, effective versions, fairness ordering and unavailable residents. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { rankDutyCandidates } from "./duty-candidates.js";
import { parseDutyData, type DutyData } from "./duty-data.js";
import { parseDutyHistory } from "./duty-history.js";

function data() {
  const source = JSON.parse(readFileSync(new URL("./fixtures/example.json", import.meta.url), "utf8"));
  const parsed = parseDutyData(source);
  return parseDutyData({
    ...parsed,
    residents: parsed.residents.slice(0, 3).map((resident) => ({ ...resident, workSchedule: "five_two", activeFrom: "2020-01-01" })),
    workShifts: [], calendarOverrides: [], exceptions: [],
  });
}

function approved(id: string, date: string, residentId: string, objectId = "dining", credit = 1) {
  return { id, date, version: 1, status: "approved", assignments: [{ residentId, objectId, credit }] };
}

function history(input: DutyData, schedules: unknown[] = [], mode: "imported" | "zero_start" = "imported", fromDate = "2026-10-01") {
  return parseDutyHistory({ mode, fromDate, schedules }, input);
}

const date = "2026-12-10";

describe("rankDutyCandidates", () => {
  it("includes D-30 and D-1 but excludes older, same-day and later assignments", () => {
    const input = data();
    const records = ["2026-11-09", "2026-11-10", "2026-12-09", date, "2026-12-11"].map((day, index) => approved(`s${index}`, day, "r01"));
    const result = rankDutyCandidates(input, history(input, records), "dining", date);
    expect(result).toMatchObject({ windowStart: "2026-11-10", windowEnd: "2026-12-09", countedFrom: "2026-11-10" });
    expect(result.candidates.find((item) => item.residentId === "r01")).toMatchObject({ dutyCount: 2, load: 2, lastDutyDate: "2026-12-09" });
  });

  it("counts only the approved replacement, ignoring draft, cancelled and superseded schedules", () => {
    const input = data();
    const records = [
      { ...approved("old", "2026-11-20", "r01", "dining", 5), status: "superseded" },
      { ...approved("new", "2026-11-20", "r01"), version: 2 },
      { ...approved("draft", "2026-11-21", "r01"), status: "draft" },
      { ...approved("cancelled", "2026-11-22", "r01"), status: "cancelled" },
    ];
    const result = rankDutyCandidates(input, history(input, records), "dining", date);
    expect(result.candidates.find((item) => item.residentId === "r01")).toMatchObject({ dutyCount: 1, load: 1, lastDutyDate: "2026-11-20" });
  });

  it("credits each member of a dining pair separately", () => {
    const input = data();
    const item = approved("pair", "2026-11-20", "r01");
    item.assignments.push({ residentId: "r02", objectId: "dining", credit: 1 });
    const result = rankDutyCandidates(input, history(input, [item]), "dining", date);
    expect(result.candidates.map((candidate) => [candidate.residentId, candidate.load])).toEqual([["r03", 0], ["r01", 1], ["r02", 1]]);
  });

  it("prefers lower workload before the date of last duty", () => {
    const input = data();
    const records = [approved("a", "2026-11-20", "r01"), approved("b", "2026-11-10", "r02"), approved("c", "2026-11-11", "r02")];
    expect(rankDutyCandidates(input, history(input, records), "dining", date).candidates.map((item) => item.residentId)).toEqual(["r03", "r01", "r02"]);
  });

  it("breaks equal workload by the older last duty", () => {
    const input = data();
    const records = [approved("a", "2026-11-20", "r01"), approved("b", "2026-11-10", "r02")];
    expect(rankDutyCandidates(input, history(input, records), "dining", date).candidates.map((item) => item.residentId)).toEqual(["r03", "r02", "r01"]);
  });

  it("uses object rotation after equal workload and the same last duty date", () => {
    const input = data();
    const common = approved("common", "2026-12-01", "r01", "laundry");
    common.assignments.push({ residentId: "r02", objectId: "laundry", credit: 1 });
    const records = [approved("a", "2026-11-11", "r01"), approved("b", "2026-11-10", "r02"), common];
    expect(rankDutyCandidates(input, history(input, records), "dining", date).candidates.map((item) => item.residentId)).toEqual(["r03", "r02", "r01"]);
  });

  it("obeys the configured order of supported criteria", () => {
    const input = data();
    input.rules.priorities = ["longest_since_object", "least_duties"];
    const records = [approved("a", "2026-11-12", "r01", "laundry"), approved("b", "2026-11-13", "r01", "laundry"), approved("c", "2026-11-14", "r02")];
    expect(rankDutyCandidates(input, history(input, records), "dining", date).candidates.map((item) => item.residentId)).toEqual(["r03", "r01", "r02"]);
  });

  it("uses stable IDs for a complete tie without rearranging the input residents", () => {
    const input = data();
    input.residents.reverse();
    expect(rankDutyCandidates(input, history(input), "dining", date).candidates.map((item) => item.residentId)).toEqual(["r01", "r02", "r03"]);
    expect(input.residents.map((item) => item.id)).toEqual(["r03", "r02", "r01"]);
  });

  it("keeps old last-duty dates even outside the workload window", () => {
    const input = data();
    const records = [approved("a", "2026-10-02", "r01"), approved("b", "2026-10-05", "r02")];
    const result = rankDutyCandidates(input, history(input, records), "dining", date);
    expect(result.candidates.map((item) => [item.residentId, item.load, item.lastDutyDate])).toEqual([
      ["r03", 0, null], ["r01", 0, "2026-10-02"], ["r02", 0, "2026-10-05"],
    ]);
  });

  it("filters by the object's periods using availability and owner exceptions", () => {
    const input = data();
    input.exceptions = [{ residentId: "r01", date, morning: true }];
    const result = rankDutyCandidates(input, history(input), "floor-1", date);
    expect(result.candidates.map((item) => [item.residentId, item.periods])).toEqual([["r01", ["morning"]]]);
  });

  it("excludes missing shifts, departed people and people not yet resident", () => {
    const input = data();
    input.residents[0].activeFrom = "2026-12-11";
    input.residents[1].inactiveFrom = date;
    input.residents[2].workSchedule = "shift";
    expect(rankDutyCandidates(input, history(input), "dining", date).candidates).toEqual([]);
  });

  it("uses saved credits rather than today's object weights", () => {
    const input = data();
    input.objects[0].creditPerPerson = 99;
    const records = [approved("a", "2026-11-12", "r01"), approved("b", "2026-11-13", "r02", "dining", 2)];
    const result = rankDutyCandidates(input, history(input, records), "dining", date);
    expect(result.candidates.map((item) => [item.residentId, item.dutyCount, item.load])).toEqual([["r03", 0, 0], ["r01", 1, 1], ["r02", 1, 2]]);
  });

  it("uses the editable lookback window", () => {
    const input = data();
    input.rules.lookbackDays = 14;
    const records = [approved("a", "2026-11-25", "r01"), approved("b", "2026-11-26", "r01")];
    const result = rankDutyCandidates(input, history(input, records), "dining", date);
    expect(result.windowStart).toBe("2026-11-26");
    expect(result.candidates.find((item) => item.residentId === "r01")?.load).toBe(1);
  });

  it("requires history or an explicit zero-start choice", () => {
    const input = data();
    expect(() => rankDutyCandidates(input, parseDutyHistory({ mode: "not_loaded" }, input), "dining", date)).toThrow("AGENT_DUTY_HISTORY_NOT_READY");
    expect(() => rankDutyCandidates(input, history(input, [], "imported", "2026-12-01"), "dining", date)).toThrow("AGENT_DUTY_HISTORY_NOT_READY");
  });

  it("exposes a confirmed zero baseline without pretending earlier days are known", () => {
    const input = data();
    const result = rankDutyCandidates(input, history(input, [approved("a", "2026-12-06", "r01")], "zero_start", "2026-12-05"), "dining", date);
    expect(result).toMatchObject({ mode: "zero_start", accountingFrom: "2026-12-05", windowStart: "2026-11-10", countedFrom: "2026-12-05" });
    expect(result.candidates.find((item) => item.residentId === "r01")?.load).toBe(1);
  });

  it("permits zero start on the requested day but not after it", () => {
    const input = data();
    expect(rankDutyCandidates(input, history(input, [], "zero_start", date), "dining", date).candidates.every((item) => item.load === 0)).toBe(true);
    expect(() => rankDutyCandidates(input, history(input, [], "zero_start", "2026-12-11"), "dining", date)).toThrow("AGENT_DUTY_HISTORY_NOT_READY");
  });

  it.each([
    ["2027-01-01", "2026-12-02", "2026-12-31"],
    ["2028-03-01", "2028-01-31", "2028-02-29"],
  ])("calculates calendar window boundaries for %s", (day, windowStart, windowEnd) => {
    const input = data();
    expect(rankDutyCandidates(input, history(input, [], "imported", "2025-01-01"), "dining", day)).toMatchObject({ windowStart, windowEnd });
  });

  it("does not mutate rules, history or row order", () => {
    const input = data();
    const saved = history(input, [approved("a", "2026-11-12", "r01")]);
    const before = structuredClone({ input, saved });
    rankDutyCandidates(input, saved, "dining", date);
    expect({ input, saved }).toEqual(before);
  });

  it("reports an unknown object and invalid query date", () => {
    const input = data();
    const saved = history(input);
    expect(() => rankDutyCandidates(input, saved, "unknown", date)).toThrow("AGENT_DUTY_OBJECT_NOT_FOUND");
    expect(() => rankDutyCandidates(input, saved, "dining", "2026-02-30")).toThrow("AGENT_DUTY_DATE_INVALID");
  });

  it("reports a window outside supported dates instead of throwing a Date error", () => {
    const input = data();
    input.rules.lookbackDays = Number.MAX_SAFE_INTEGER;
    expect(() => rankDutyCandidates(input, history(input), "dining", date)).toThrow("AGENT_DUTY_WINDOW_INVALID");
  });
});
