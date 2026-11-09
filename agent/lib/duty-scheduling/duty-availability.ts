/**
 * Pure availability calculation for one resident on a household calendar date.
 *
 * Input must first pass parseDutyData. Missing shifts and residency boundaries
 * block assignment before exceptions; calendar overrides take precedence over
 * weekday settings. The returned basis makes these cases distinguishable.
 */
import { AppError } from "../app-error.js";
import { parseDutyDate, type DutyAvailabilityKind, type DutyData } from "./duty-data.js";

export type DutyAvailability = Readonly<{
  residentId: string;
  date: string;
  morning: boolean;
  evening: boolean;
  basis: DutyAvailabilityKind | "missing_shift" | "not_yet_resident" | "departed";
  exceptionApplied: boolean;
}>;

export function getDutyAvailability(data: DutyData, residentId: string, requestedDate: string): DutyAvailability {
  const date = parseDutyDate(requestedDate);
  const resident = data.residents.find((item) => item.id === residentId);
  if (!resident) {
    throw new AppError("AGENT_DUTY_RESIDENT_NOT_FOUND", "Жилец с таким ID отсутствует в списке");
  }

  const unavailable = (basis: DutyAvailability["basis"]): DutyAvailability => ({
    residentId, date, morning: false, evening: false, basis, exceptionApplied: false,
  });
  // ISO calendar dates sort in chronological order; departure is an exclusive bound.
  if (date < resident.activeFrom) return unavailable("not_yet_resident");
  if (resident.inactiveFrom !== undefined && date >= resident.inactiveFrom) return unavailable("departed");

  const calendarOverride = data.calendarOverrides.find((item) => item.date === date);
  // The string already denotes the household's day, not an instant to convert between timezones.
  const isoWeekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const isDayOff = calendarOverride?.isDayOff ?? data.rules.weekendDays.includes(isoWeekday);

  let basis: DutyAvailabilityKind;
  if (resident.workSchedule === "five_two") {
    basis = isDayOff ? "five_two_day_off" : "five_two_workday";
  } else {
    const shift = data.workShifts.find((item) => item.residentId === residentId && item.date === date);
    if (!shift) return unavailable("missing_shift");
    basis = shift.state === "off"
      ? (isDayOff ? "shift_off_day_off" : "shift_off_workday")
      : `shift_${shift.state}`;
  }

  const base = data.rules.availability[basis];
  const exception = data.exceptions.find((item) => item.residentId === residentId && item.date === date);
  return {
    residentId,
    date,
    morning: exception?.morning ?? base.morning,
    evening: exception?.evening ?? base.evening,
    basis,
    exceptionApplied: exception !== undefined,
  };
}
