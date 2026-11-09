/**
 * Validated input snapshot for household duty scheduling.
 *
 * Exports the data contract and its parser. Dates are household calendar days,
 * IDs survive name changes, and supported rules are data rather than defaults.
 * Parsing does not fill missing shifts, calculate assignments, or authorize edits.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u, "Укажите постоянный ID без пробелов");
const nameSchema = z.string().trim().min(1, "Укажите непустое название или имя").max(100);
const dateSchema = z.iso.date({ error: "Укажите существующую дату в формате YYYY-MM-DD" });
const periodSchema = z.enum(["morning", "evening"]);
const availabilitySchema = z.object({ morning: z.boolean(), evening: z.boolean() }).strict();
const availabilityKindSchema = z.enum([
  "five_two_workday", "five_two_day_off", "shift_day", "shift_night",
  "shift_recovery", "shift_off_workday", "shift_off_day_off",
]);
const prioritySchema = z.enum(["least_duties", "longest_since_duty", "longest_since_object"]);

const residentSchema = z.object({
  id: idSchema,
  firstName: nameSchema.optional(),
  lastName: nameSchema,
  workSchedule: z.enum(["five_two", "shift"]),
  activeFrom: dateSchema,
  inactiveFrom: dateSchema.optional(),
}).strict().superRefine((resident, ctx) => {
  if (resident.inactiveFrom !== undefined && resident.inactiveFrom < resident.activeFrom) {
    ctx.addIssue({ code: "custom", path: ["inactiveFrom"], message: "Дата выезда не может быть раньше даты заселения" });
  }
});

const recurrenceSchema = z.object({
  everyDays: z.number().int().positive(),
  anchorDate: dateSchema.optional(),
}).strict().superRefine((recurrence, ctx) => {
  if (recurrence.everyDays > 1 && recurrence.anchorDate === undefined) {
    ctx.addIssue({ code: "custom", path: ["anchorDate"], message: "Для цикла через несколько дней укажите дату начала" });
  }
});

const objectSchema = z.object({
  id: idSchema,
  name: nameSchema,
  people: z.number().int().positive(),
  samePeriod: z.boolean(),
  periods: z.array(periodSchema).min(1).refine(uniqueValues, "Периоды не должны повторяться"),
  creditPerPerson: z.number().int().positive(),
  recurrence: recurrenceSchema,
}).strict();

const shiftSchema = z.object({
  residentId: idSchema,
  date: dateSchema,
  state: z.enum(["day", "night", "recovery", "off"]),
}).strict();

const exceptionSchema = z.object({
  residentId: idSchema,
  date: dateSchema,
  morning: z.boolean().optional(),
  evening: z.boolean().optional(),
}).strict().refine(
  (exception) => exception.morning !== undefined || exception.evening !== undefined,
  "Укажите доступность хотя бы одного периода",
);

const rulesSchema = z.object({
  version: idSchema,
  weekendDays: z.array(z.number().int().min(1).max(7)).refine(uniqueValues, "Дни недели не должны повторяться"),
  availability: z.record(availabilityKindSchema, availabilitySchema),
  maxAssignmentsPerDay: z.number().int().positive(),
  lookbackDays: z.number().int().positive(),
  priorities: z.array(prioritySchema).min(1).refine(uniqueValues, "Критерии не должны повторяться"),
  allowIncompleteSchedules: z.boolean(),
}).strict();

const dataSchema = z.object({
  schemaVersion: z.literal(1),
  timezone: z.string().refine(validTimezone, "Укажите существующий часовой пояс, например Europe/Moscow"),
  residents: z.array(residentSchema),
  objects: z.array(objectSchema).min(1),
  workShifts: z.array(shiftSchema),
  calendarOverrides: z.array(z.object({ date: dateSchema, isDayOff: z.boolean() }).strict()),
  exceptions: z.array(exceptionSchema),
  rules: rulesSchema,
}).strict().superRefine((data, ctx) => {
  checkDuplicates(data.residents, (row) => row.id, "residents", ctx);
  checkDuplicates(data.objects, (row) => row.id, "objects", ctx);
  checkDuplicates(data.workShifts, (row) => `${row.residentId}/${row.date}`, "workShifts", ctx);
  checkDuplicates(data.exceptions, (row) => `${row.residentId}/${row.date}`, "exceptions", ctx);
  checkDuplicates(data.calendarOverrides, (row) => row.date, "calendarOverrides", ctx);

  const residents = new Map(data.residents.map((resident) => [resident.id, resident]));
  for (const collection of ["workShifts", "exceptions"] as const) {
    data[collection].forEach((row, index) => {
      const resident = residents.get(row.residentId);
      if (!resident) {
        ctx.addIssue({ code: "custom", path: [collection, index, "residentId"], message: "Жилец с таким ID отсутствует в списке" });
      } else if (collection === "workShifts" && resident.workSchedule !== "shift") {
        ctx.addIssue({ code: "custom", path: [collection, index, "residentId"], message: "Смену можно указать только жильцу со сменным графиком" });
      }
    });
  }
});

export type DutyData = z.infer<typeof dataSchema>;
export type DutyResident = DutyData["residents"][number];
export type DutyObject = DutyData["objects"][number];
export type DutyPeriod = z.infer<typeof periodSchema>;
export type DutyShiftState = z.infer<typeof shiftSchema>["state"];
export type DutyAvailabilityKind = keyof DutyData["rules"]["availability"];
export { dateSchema as dutyDateSchema, idSchema as dutyIdSchema };

/** A requested day uses the same calendar-date contract as imported rows. */
export function parseDutyDate(value: unknown): string {
  const result = dateSchema.safeParse(value);
  if (!result.success) {
    throw new AppError("AGENT_DUTY_DATE_INVALID", "Укажите существующую дату в формате YYYY-MM-DD");
  }
  return result.data;
}

/** Validate decoded JSON/table data without disclosing row values in errors. */
export function parseDutyData(value: unknown): DutyData {
  const result = dataSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "данные"}: ${issue.message}`);
    throw new AppError("AGENT_DUTY_DATA_INVALID", `Некорректные данные дежурств: ${issues.join("; ")}`);
  }
  return result.data;
}

function uniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function checkDuplicates<T>(rows: readonly T[], key: (row: T) => string, path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const value = key(row);
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", path: [path, index], message: "Повторяющийся ID или несколько записей на один день" });
    }
    seen.add(value);
  });
}
