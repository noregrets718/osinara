/** Joint allocation constraints, global objectives and explicit search exhaustion. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { prepareDutyDraft } from "./duty-allocation.js";
import { parseDutyData, type DutyData, type DutyObject, type DutyPeriod } from "./duty-data.js";
import { parseDutyHistory } from "./duty-history.js";

const date = "2026-11-09";

function object(id: string, people = 1, periods: DutyPeriod[] = ["morning", "evening"], samePeriod = true): DutyObject {
  return { id, name: id, people, periods, samePeriod, creditPerPerson: 1, recurrence: { everyDays: 1 } };
}

function data() {
  const source = parseDutyData(JSON.parse(readFileSync(new URL("./fixtures/example.json", import.meta.url), "utf8")));
  return parseDutyData({ ...source, residents: source.residents.slice(0, 3).map((resident) => ({ ...resident, workSchedule: "five_two", activeFrom: "2020-01-01" })),
    objects: [object("a"), object("b")], workShifts: [], exceptions: [], calendarOverrides: [{ date, isDayOff: true }] });
}

function history(input: DutyData, schedules: unknown[] = []) {
  return parseDutyHistory({ mode: "zero_start", fromDate: "2026-11-01", schedules }, input);
}

function assignments(draft: ReturnType<typeof prepareDutyDraft>) {
  return draft.objects.flatMap((item) => item.assignments.map((row) => `${item.objectId}/${row.residentId}/${row.period}`)).sort();
}

describe("prepareDutyDraft", () => {
  it("fills the fictional household and keeps the dining pair together", () => {
    const input = parseDutyData(JSON.parse(readFileSync(new URL("./fixtures/example.json", import.meta.url), "utf8")));
    const saved = parseDutyHistory(JSON.parse(readFileSync(new URL("./fixtures/history.json", import.meta.url), "utf8")), input);
    const result = prepareDutyDraft(input, saved, date);
    expect(result).toMatchObject({ filledSlots: 6, requiredSlots: 6, complete: true, canApprove: true });
    const pair = result.objects.find((item) => item.objectId === "dining");
    expect(pair?.assignments).toHaveLength(2);
    expect(new Set(pair?.assignments.map((row) => row.period)).size).toBe(1);
    const ids = result.objects.flatMap((item) => item.assignments.map((row) => row.residentId));
    expect(new Set(ids).size).toBe(6);
  });

  it("does not spend the only morning worker on a flexible object", () => {
    const input = data();
    input.residents = input.residents.slice(0, 2);
    input.objects = [object("a-flex"), object("b-morning", 1, ["morning"])];
    input.exceptions = [{ residentId: "r02", date, morning: false }];
    expect(assignments(prepareDutyDraft(input, history(input), date))).toEqual(["a-flex/r02/evening", "b-morning/r01/morning"]);
  });

  it("chooses an evening pair to preserve the morning worker even at higher workload", () => {
    const input = data();
    input.objects = [object("pair", 2), object("morning", 1, ["morning"])];
    input.exceptions = [{ residentId: "r01", date, evening: false }, { residentId: "r03", date, morning: false }];
    const saved = history(input, [{ id: "old", date: "2026-11-08", version: 1, status: "approved", assignments: [{ residentId: "r03", objectId: "pair", credit: 10 }] }]);
    const result = prepareDutyDraft(input, saved, date);
    expect(result.filledSlots).toBe(3);
    expect(assignments(result)).toEqual(["morning/r01/morning", "pair/r02/evening", "pair/r03/evening"]);
  });

  it("can leave a smaller team empty to fill more places in another team", () => {
    const input = data();
    input.objects = [object("a-small", 2, ["morning"]), object("b-large", 3, ["evening"])];
    input.exceptions = [{ residentId: "r03", date, morning: false }];
    const result = prepareDutyDraft(input, history(input), date);
    expect(result).toMatchObject({ filledSlots: 3, unfilledSlots: 2, complete: false });
    expect(result.objects[0].assignments).toHaveLength(0);
    expect(result.objects[1].assignments).toHaveLength(3);
  });

  it("improves group fairness after finding an equally complete morning solution", () => {
    const input = data();
    input.objects = [object("pair", 2)];
    input.exceptions = [{ residentId: "r01", date, evening: false }, { residentId: "r03", date, morning: false }];
    const saved = history(input, [{ id: "old", date: "2026-11-08", version: 1, status: "approved", assignments: [{ residentId: "r01", objectId: "pair", credit: 5 }] }]);
    expect(assignments(prepareDutyDraft(input, saved, date))).toEqual(["pair/r02/evening", "pair/r03/evening"]);
  });

  it("never labels one person as a completed pair or mixes morning and evening teammates", () => {
    const input = data();
    input.residents = input.residents.slice(0, 2);
    input.objects = [object("pair", 2)];
    input.exceptions = [{ residentId: "r01", date, evening: false }, { residentId: "r02", date, morning: false }];
    const result = prepareDutyDraft(input, history(input), date);
    expect(result).toMatchObject({ filledSlots: 0, unfilledSlots: 2 });
    expect(result.objects[0].assignments).toEqual([]);
    expect(result.objects[0].unfilledReason).toContain("совместной группы");
  });

  it("reports shortage while preserving a one-assignment daily limit", () => {
    const input = data();
    input.residents = input.residents.slice(0, 2);
    input.objects.push(object("c"));
    const result = prepareDutyDraft(input, history(input), date);
    expect(result).toMatchObject({ requiredSlots: 3, filledSlots: 2, unfilledSlots: 1, complete: false, canApprove: true });
    expect(new Set(result.objects.flatMap((item) => item.assignments.map((row) => row.residentId))).size).toBe(2);
  });

  it("honors both an editable daily limit and the prohibition of a duplicate person within a team", () => {
    const input = data();
    input.residents = input.residents.slice(0, 1);
    input.rules.maxAssignmentsPerDay = 2;
    expect(prepareDutyDraft(input, history(input), date).filledSlots).toBe(2);
    input.objects = [object("pair", 2)];
    expect(prepareDutyDraft(input, history(input), date).filledSlots).toBe(0);
  });

  it("allows partially filled independent multi-person work and honors the completeness policy", () => {
    const input = data();
    input.residents = input.residents.slice(0, 2);
    input.objects = [object("separate", 3, ["morning", "evening"], false)];
    input.rules.allowIncompleteSchedules = false;
    const result = prepareDutyDraft(input, history(input), date);
    expect(result).toMatchObject({ filledSlots: 2, unfilledSlots: 1, canApprove: false });
    expect(result.objects[0].assignments).toHaveLength(2);
  });

  it("uses low workload before tie-breakers and saves the real selection facts", () => {
    const input = data();
    input.objects = [object("a")];
    const saved = history(input, [{ id: "old", date: "2026-11-08", version: 1, status: "approved", assignments: [{ residentId: "r01", objectId: "a", credit: 5 }] }]);
    const result = prepareDutyDraft(input, saved, date);
    expect(result.objects[0].assignments[0]).toMatchObject({ residentId: "r02", credit: 1, rank: 1, loadBefore: 0, lastDutyDate: null });
  });

  it("optimizes object rotation across the whole day", () => {
    const input = data();
    input.residents = input.residents.slice(0, 2);
    const saved = history(input, [{ id: "old", date: "2026-11-08", version: 1, status: "approved", assignments: [
      { residentId: "r01", objectId: "a", credit: 1 }, { residentId: "r02", objectId: "b", credit: 1 },
    ] }]);
    expect(assignments(prepareDutyDraft(input, saved, date))).toEqual(["a/r02/morning", "b/r01/morning"]);
  });

  it("keeps assignments deterministic under input reordering and leaves snapshots unchanged", () => {
    const input = data();
    const saved = history(input);
    const before = structuredClone({ input, saved });
    const first = prepareDutyDraft(input, saved, date);
    expect({ input, saved }).toEqual(before);
    input.residents.reverse();
    input.objects.reverse();
    input.objects.forEach((item) => item.periods.reverse());
    expect(assignments(prepareDutyDraft(input, saved, date))).toEqual(assignments(first));
  });

  it("preserves missing-shift and residency exclusions", () => {
    const input = data();
    input.residents[0].workSchedule = "shift";
    input.residents[1].inactiveFrom = date;
    input.residents[2].activeFrom = "2026-11-10";
    expect(prepareDutyDraft(input, history(input), date)).toMatchObject({ filledSlots: 0, unfilledSlots: 2, missingShiftResidentIds: ["r01"] });
  });

  it("returns an empty complete day with explicit accounting when no object is due", () => {
    const input = data();
    input.objects = [{ ...object("a"), recurrence: { everyDays: 2, anchorDate: "2026-11-10" } }];
    expect(prepareDutyDraft(input, history(input), date)).toMatchObject({ objects: [], requiredSlots: 0, filledSlots: 0, complete: true });
  });

  it("requires accounting readiness before generating any assignments", () => {
    const input = data();
    expect(() => prepareDutyDraft(input, parseDutyHistory({ mode: "not_loaded" }, input), date)).toThrow("AGENT_DUTY_HISTORY_NOT_READY");
  });

  it("fails explicitly on a search limit rather than returning a partial optimum", () => {
    const input = data();
    expect(() => prepareDutyDraft(input, history(input), date, { maxSearchStates: 1 })).toThrow("AGENT_DUTY_SEARCH_LIMIT");
    expect(() => prepareDutyDraft(input, history(input), date, { maxSearchStates: 0 })).toThrow("AGENT_DUTY_SEARCH_INVALID");
  });

  it("rejects a total slot count outside exact integer arithmetic", () => {
    const input = data();
    input.objects.forEach((item) => { item.people = Number.MAX_SAFE_INTEGER; });
    expect(() => prepareDutyDraft(input, history(input), date)).toThrow("AGENT_DUTY_CAPACITY_INVALID");
  });

  it("matches brute-force coverage for all 64 three-person availability combinations", () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const input = data();
      input.objects = [object("pair", 2), object("am", 1, ["morning"]), object("pm", 1, ["evening"])];
      const availability = input.residents.map((resident, index) => ({ residentId: resident.id, date,
        morning: (mask & (1 << (index * 2))) !== 0, evening: (mask & (1 << (index * 2 + 1))) !== 0 }));
      input.exceptions = availability;
      let optimum = 0;
      // Independent oracle: each person goes nowhere, to the pair, AM, or PM.
      for (let placement = 0; placement < 64; placement += 1) {
        const jobs = [placement % 4, Math.floor(placement / 4) % 4, Math.floor(placement / 16) % 4];
        const pair = jobs.flatMap((job, index) => job === 1 ? [index] : []);
        if (pair.length !== 0 && pair.length !== 2) continue;
        if (jobs.filter((job) => job === 2).length > 1 || jobs.filter((job) => job === 3).length > 1) continue;
        if (pair.length === 2 && !["morning", "evening"].some((period) => pair.every((index) => period === "morning" ? availability[index].morning : availability[index].evening))) continue;
        if (jobs.some((job, index) => (job === 2 && !availability[index].morning) || (job === 3 && !availability[index].evening))) continue;
        optimum = Math.max(optimum, jobs.filter((job) => job !== 0).length);
      }
      expect(prepareDutyDraft(input, history(input), date).filledSlots).toBe(optimum);
    }
  });
});
