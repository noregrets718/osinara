/** Joint daily allocation: complete simultaneous teams plus exact matching of other slots. */
import { AppError } from "../app-error.js";
import { getDutyAvailability } from "./duty-availability.js";
import { rankDutyCandidates, type DutyCandidate } from "./duty-candidates.js";
import { getDutyObjectsForDate, type DutyDayObject } from "./duty-day-objects.js";
import type { DutyData, DutyPeriod } from "./duty-data.js";
import type { DutyHistory } from "./duty-history.js";
import { addDutyCosts, compareDutyCosts, matchDutySlots, type DutyCost, type DutyMatchChoice } from "./duty-matching.js";

export type DutyDraftAssignment = Readonly<{
  residentId: string; period: DutyPeriod; credit: number; rank: number;
  loadBefore: number; dutyCountBefore: number; lastDutyDate: string | null; lastObjectDate: string | null;
}>;

export type DutyDraftObject = DutyDayObject & Readonly<{
  assignments: readonly DutyDraftAssignment[]; unfilledSlots: number; unfilledReason: string | null;
}>;

export type DutyDraft = Readonly<{
  date: string; rulesVersion: string; requiredSlots: number; filledSlots: number;
  unfilledSlots: number; complete: boolean; canApprove: boolean;
  missingShiftResidentIds: readonly string[];
  accounting: Readonly<{ mode: "imported" | "zero_start"; fromDate: string; windowStart: string; windowEnd: string; countedFrom: string }>;
  objects: readonly DutyDraftObject[];
}>;

type Choice = DutyMatchChoice & { candidate: DutyCandidate; rank: number };
const PERIODS: readonly DutyPeriod[] = ["morning", "evening"];

/** Validated snapshots only. Search exhaustion throws; it never returns an unproven optimum. */
export function prepareDutyDraft(data: DutyData, history: DutyHistory, requestedDate: string, options: { maxSearchStates?: number } = {}): DutyDraft {
  const limit = options.maxSearchStates ?? 50_000;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new AppError("AGENT_DUTY_SEARCH_INVALID", "Лимит поиска должен быть положительным целым числом");
  let states = 0;
  const visit = () => {
    states += 1;
    if (states > limit) throw new AppError("AGENT_DUTY_SEARCH_LIMIT", "Поиск не завершён в пределах лимита; готовый график не сформирован");
  };

  const requirements = getDutyObjectsForDate(data.objects, requestedDate);
  if (!Number.isSafeInteger(requirements.requiredSlots)) {
    throw new AppError("AGENT_DUTY_CAPACITY_INVALID", "Число мест слишком велико для точного подбора");
  }
  const date = requirements.date;
  const rankings = new Map(requirements.objects.map((object) => [object.objectId, rankDutyCandidates(data, history, object.objectId, date)]));
  // An empty cleaning day still has an explicit, validated accounting context.
  const context = rankings.values().next().value ?? rankDutyCandidates(data, history, data.objects[0].id, date);
  const zero = data.rules.priorities.map(() => 0);
  const dayValue = (value: string | null) => value === null ? 0
    : (Date.parse(`${value}T00:00:00Z`) - Date.parse(`${context.accountingFrom}T00:00:00Z`)) / 86_400_000 + 1;
  const costs = new Map<string, readonly Choice[]>();
  for (const [objectId, ranking] of rankings) {
    const choices = ranking.candidates.map((candidate, index) => ({
      residentId: candidate.residentId, objectId, period: PERIODS.find((period) => candidate.periods.includes(period)) ?? "morning",
      candidate, rank: index + 1,
      cost: data.rules.priorities.map((priority) => priority === "least_duties" ? candidate.load
        : priority === "longest_since_duty" ? dayValue(candidate.lastDutyDate) : dayValue(candidate.lastObjectDate)),
    }));
    costs.set(objectId, choices);
  }

  const ordered = [...requirements.objects].sort((left, right) => left.objectId < right.objectId ? -1 : 1);
  const teams = ordered.filter((object) => object.samePeriod && object.people > 1);
  const independent = ordered.filter((object) => !object.samePeriod || object.people === 1);
  const capacities = new Map(data.residents.map((resident) => [resident.id, data.rules.maxAssignmentsPerDay]));
  const selected: Choice[] = [];
  let best: Choice[] = [];
  let bestCost: DutyCost = zero;
  let bestFilled = -1;

  function search(index: number, cost: DutyCost): void {
    visit();
    const upperBound = selected.length + teams.slice(index).reduce((sum, object) => sum + object.people, 0)
      + independent.reduce((sum, object) => sum + object.people, 0);
    if (upperBound < bestFilled) return;
    // Remaining assignment costs are non-negative; equal ties keep the first stable solution.
    if (upperBound === bestFilled && compareDutyCosts(cost, bestCost) >= 0) return;
    if (index === teams.length) {
      const choices = independent.flatMap((object) => costs.get(object.objectId) ?? []);
      const rest = matchDutySlots(independent, capacities, choices, visit);
      const combinedCost = rest.reduce((sum, choice) => addDutyCosts(sum, choice.cost), cost);
      const filled = selected.length + rest.length;
      if (filled > bestFilled || (filled === bestFilled && compareDutyCosts(combinedCost, bestCost) < 0)) {
        best = [...selected, ...rest];
        bestCost = combinedCost;
        bestFilled = filled;
      }
      return;
    }

    const object = teams[index];
    for (const period of PERIODS.filter((item) => object.periods.includes(item))) {
      const candidates = (costs.get(object.objectId) ?? []).filter((choice) => choice.candidate.periods.includes(period));
      function chooseTeam(start: number, remaining: number, nextCost: DutyCost): void {
        visit();
        if (remaining === 0) {
          search(index + 1, nextCost);
          return;
        }
        for (let position = start; position <= candidates.length - remaining; position += 1) {
          const choice = candidates[position];
          const capacity = capacities.get(choice.residentId) ?? 0;
          if (capacity < 1) continue;
          capacities.set(choice.residentId, capacity - 1);
          selected.push({ ...choice, period });
          chooseTeam(position + 1, remaining - 1, addDutyCosts(nextCost, choice.cost));
          selected.pop();
          capacities.set(choice.residentId, capacity);
        }
      }
      chooseTeam(0, object.people, cost);
    }
    // An unfilled whole team can free people to close more slots elsewhere.
    search(index + 1, cost);
  }
  search(0, zero);

  const objects = requirements.objects.map((object): DutyDraftObject => {
    const assignments = best.filter((choice) => choice.objectId === object.objectId)
      .sort((left, right) => left.residentId < right.residentId ? -1 : 1)
      .map((choice): DutyDraftAssignment => ({
        residentId: choice.residentId, period: choice.period, credit: object.creditPerPerson, rank: choice.rank,
        loadBefore: choice.candidate.load, dutyCountBefore: choice.candidate.dutyCount,
        lastDutyDate: choice.candidate.lastDutyDate, lastObjectDate: choice.candidate.lastObjectDate,
      }));
    const unfilledSlots = object.people - assignments.length;
    return { ...object, assignments, unfilledSlots, unfilledReason: unfilledSlots === 0 ? null
      : object.samePeriod && object.people > 1 ? "Нет полной совместной группы с учётом других назначений."
      : "Не хватает доступных исполнителей с учётом дневного ограничения." };
  });
  const complete = bestFilled === requirements.requiredSlots;
  const missingShiftResidentIds = data.residents.filter((resident) =>
    getDutyAvailability(data, resident.id, date).basis === "missing_shift"
  ).map((resident) => resident.id).sort();
  return {
    date, rulesVersion: data.rules.version, requiredSlots: requirements.requiredSlots, filledSlots: bestFilled,
    unfilledSlots: requirements.requiredSlots - bestFilled, complete, canApprove: complete || data.rules.allowIncompleteSchedules,
    missingShiftResidentIds,
    accounting: { mode: context.mode, fromDate: context.accountingFrom, windowStart: context.windowStart, windowEnd: context.windowEnd, countedFrom: context.countedFrom },
    objects,
  };
}
