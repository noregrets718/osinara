/** Validated accounting baseline and versioned history; no implicit zero start. */
import { z } from "zod";

import { AppError } from "../app-error.js";
import { dutyDateSchema, dutyIdSchema, type DutyData } from "./duty-data.js";

const assignmentSchema = z.object({
  residentId: dutyIdSchema,
  objectId: dutyIdSchema,
  credit: z.number().int().positive(),
}).strict();

const scheduleSchema = z.object({
  id: dutyIdSchema,
  date: dutyDateSchema,
  version: z.number().int().positive(),
  status: z.enum(["draft", "approved", "cancelled", "superseded"]),
  assignments: z.array(assignmentSchema),
}).strict();

const readyShape = { fromDate: dutyDateSchema, schedules: z.array(scheduleSchema) };
const historySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("not_loaded") }).strict(),
  z.object({ mode: z.literal("imported"), ...readyShape }).strict(),
  z.object({ mode: z.literal("zero_start"), ...readyShape }).strict(),
]);

export type DutyHistory = z.infer<typeof historySchema>;

export function parseDutyHistory(value: unknown, data: DutyData): DutyHistory {
  const parsed = historySchema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".") || "история"}: ${issue.message}`);
    throw invalidHistory(fields);
  }
  const history = parsed.data;
  if (history.mode === "not_loaded") return history;

  const residents = new Set(data.residents.map((resident) => resident.id));
  const objects = new Set(data.objects.map((object) => object.id));
  const ids = new Set<string>();
  const versions = new Set<string>();
  const approvedDates = new Set<string>();
  const issues: string[] = [];
  history.schedules.forEach((schedule, index) => {
    const path = `schedules.${index}`;
    const versionKey = `${schedule.date}/${schedule.version}`;
    if (ids.has(schedule.id)) issues.push(`${path}.id: повторный ID графика`);
    if (versions.has(versionKey)) issues.push(`${path}.version: повторная версия на дату`);
    if (schedule.date < history.fromDate) issues.push(`${path}.date: дата раньше начала учёта`);
    if (schedule.status === "approved") {
      if (approvedDates.has(schedule.date)) issues.push(`${path}.status: на дату может действовать только одна утверждённая версия`);
      approvedDates.add(schedule.date);
    }
    ids.add(schedule.id);
    versions.add(versionKey);

    const assignments = new Set<string>();
    schedule.assignments.forEach((assignment, row) => {
      const rowPath = `${path}.assignments.${row}`;
      const key = `${assignment.residentId}/${assignment.objectId}`;
      if (!residents.has(assignment.residentId)) issues.push(`${rowPath}.residentId: неизвестный жилец`);
      if (!objects.has(assignment.objectId)) issues.push(`${rowPath}.objectId: неизвестный объект`);
      if (assignments.has(key)) issues.push(`${rowPath}: повторное назначение`);
      assignments.add(key);
    });
  });
  if (issues.length > 0) throw invalidHistory(issues);
  return history;
}

function invalidHistory(issues: string[]): AppError {
  return new AppError("AGENT_DUTY_HISTORY_INVALID", `Некорректная история дежурств: ${issues.join("; ")}`);
}
