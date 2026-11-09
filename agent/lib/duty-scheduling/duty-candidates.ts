/** Pure candidate ranking from approved history, availability and ordered rules. */
import { AppError } from "../app-error.js";
import { getDutyAvailability } from "./duty-availability.js";
import { parseDutyDate, type DutyData, type DutyPeriod } from "./duty-data.js";
import type { DutyHistory } from "./duty-history.js";

type Workload = {
  dutyCount: number;
  load: number;
  lastDutyDate: string | null;
  lastObjectDate: string | null;
};

export type DutyCandidate = Readonly<Workload & {
  residentId: string;
  periods: readonly DutyPeriod[];
}>;

export type DutyCandidateRanking = Readonly<{
  date: string;
  objectId: string;
  mode: "imported" | "zero_start";
  accountingFrom: string;
  windowStart: string;
  windowEnd: string;
  countedFrom: string;
  candidates: readonly DutyCandidate[];
}>;

/** Both snapshots must first pass their parsers; sorting never changes either input. */
export function rankDutyCandidates(data: DutyData, history: DutyHistory, objectId: string, requestedDate: string): DutyCandidateRanking {
  const date = parseDutyDate(requestedDate);
  const object = data.objects.find((item) => item.id === objectId);
  if (!object) throw new AppError("AGENT_DUTY_OBJECT_NOT_FOUND", "Объект с таким ID отсутствует в списке");
  if (history.mode === "not_loaded") {
    throw new AppError("AGENT_DUTY_HISTORY_NOT_READY", "Загрузите историю либо явно выберите начало учёта с нуля");
  }

  const windowStart = subtractDays(date, data.rules.lookbackDays);
  const windowEnd = subtractDays(date, 1);
  if (history.fromDate > date || (history.mode === "imported" && history.fromDate > windowStart)) {
    throw new AppError("AGENT_DUTY_HISTORY_NOT_READY", "История не покрывает период расчёта: загрузите недостающие дни либо подтвердите начало учёта с нуля");
  }
  const countedFrom = history.fromDate > windowStart ? history.fromDate : windowStart;
  const stats = new Map<string, Workload>();
  for (const schedule of history.schedules) {
    if (schedule.status !== "approved" || schedule.date >= date) continue;
    for (const assignment of schedule.assignments) {
      const row = stats.get(assignment.residentId) ?? emptyWorkload();
      if (schedule.date >= countedFrom) {
        row.dutyCount += 1;
        row.load += assignment.credit;
      }
      if (row.lastDutyDate === null || schedule.date > row.lastDutyDate) row.lastDutyDate = schedule.date;
      if (assignment.objectId === objectId && (row.lastObjectDate === null || schedule.date > row.lastObjectDate)) {
        row.lastObjectDate = schedule.date;
      }
      stats.set(assignment.residentId, row);
    }
  }

  const candidates = data.residents.flatMap((resident): DutyCandidate[] => {
    const availability = getDutyAvailability(data, resident.id, date);
    const periods = object.periods.filter((period) => availability[period]);
    if (periods.length === 0) return [];
    return [{ residentId: resident.id, periods, ...(stats.get(resident.id) ?? emptyWorkload()) }];
  });
  candidates.sort((left, right) => {
    for (const priority of data.rules.priorities) {
      const order = priority === "least_duties" ? left.load - right.load
        : priority === "longest_since_duty" ? compareText(left.lastDutyDate ?? "", right.lastDutyDate ?? "")
        : compareText(left.lastObjectDate ?? "", right.lastObjectDate ?? "");
      if (order !== 0) return order;
    }
    return compareText(left.residentId, right.residentId);
  });
  return { date, objectId, mode: history.mode, accountingFrom: history.fromDate, windowStart, windowEnd, countedFrom, candidates };
}

function emptyWorkload(): Workload {
  return { dutyCount: 0, load: 0, lastDutyDate: null, lastObjectDate: null };
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function subtractDays(date: string, days: number): string {
  const result = new Date(Date.parse(`${date}T00:00:00Z`) - days * 24 * 60 * 60 * 1_000);
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 0) {
    throw new AppError("AGENT_DUTY_WINDOW_INVALID", "Период учёта выходит за поддерживаемые календарные даты");
  }
  return result.toISOString().slice(0, 10);
}
