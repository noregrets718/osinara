/**
 * Required cleaning objects on a calendar date, independent of available residents.
 * Definitions must first pass parseDutyData. Recurrences begin at their anchor;
 * returned groups retain simultaneous-work constraints for the future allocator.
 */
import { AppError } from "../app-error.js";
import { parseDutyDate, type DutyObject, type DutyPeriod } from "./duty-data.js";

export type DutyDayObject = Readonly<{
  objectId: string;
  name: string;
  people: number;
  samePeriod: boolean;
  periods: readonly DutyPeriod[];
  creditPerPerson: number;
}>;

export type DutyDayRequirements = Readonly<{
  date: string;
  objects: readonly DutyDayObject[];
  requiredSlots: number;
}>;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export function getDutyObjectsForDate(objects: readonly DutyObject[], requestedDate: string): DutyDayRequirements {
  const date = parseDutyDate(requestedDate);
  const due = objects.filter((object) => {
    const { everyDays, anchorDate } = object.recurrence;
    if (anchorDate !== undefined && date < anchorDate) return false;
    if (everyDays === 1) return true;
    if (anchorDate === undefined) {
      throw new AppError("AGENT_DUTY_RECURRENCE_INVALID", "Для цикла через несколько дней укажите дату начала");
    }

    // UTC is used for calendar arithmetic, so local daylight-saving changes cannot add fractions.
    const elapsedDays = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / MILLISECONDS_PER_DAY;
    return elapsedDays % everyDays === 0;
  }).map((object): DutyDayObject => ({
    objectId: object.id,
    name: object.name,
    people: object.people,
    samePeriod: object.samePeriod,
    periods: [...object.periods],
    creditPerPerson: object.creditPerPerson,
  }));

  return { date, objects: due, requiredSlots: due.reduce((total, object) => total + object.people, 0) };
}
