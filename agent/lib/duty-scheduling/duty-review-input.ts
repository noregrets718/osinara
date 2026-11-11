/** Exact internal resolution and object-shaped owner tool contracts. */
import { z } from "zod";
import { AppError } from "../app-error.js";
export const dutySheetReviewInputSchema = z.object({ operationId: z.uuid(), profileRef: z.string().min(1).max(300).optional(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
  decision: z.enum(["cancel_unstarted", "accept_current"]), acknowledgeUncertainOutcome: z.literal(true).optional(), previewId: z.uuid().optional() }).strict();
export type DutySheetReviewInput = z.infer<typeof dutySheetReviewInputSchema>;
export const dutyReviewInspectSchema = z.object({ action: z.enum(["list", "inspect"]), operationId: z.uuid().optional(),
  profileRef: z.string().min(1).max(300).optional(), offset: z.number().int().min(0).max(10000).optional() }).strict();
const reads = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), offset: dutyReviewInspectSchema.shape.offset }).strict(),
  z.object({ action: z.literal("inspect"), operationId: z.uuid(), profileRef: dutyReviewInspectSchema.shape.profileRef }).strict(),
]);
export const dutyReviewResolveSchema = z.object({ previewId: z.uuid() }).strict();
export function parseDutyReviewInspect(raw: unknown) {
  const result = reads.safeParse(raw);
  if (!result.success) throw new AppError("AGENT_DUTY_REVIEW_INPUT_INVALID", "list: только action и необязательный offset; inspect: action, operationId и необязательный личный profileRef");
  return result.data;
}
export function parseDutyReviewResolve(raw: unknown) {
  const result = dutyReviewResolveSchema.safeParse(raw);
  if (!result.success) throw new AppError("AGENT_DUTY_REVIEW_INPUT_INVALID", "Передайте только previewId из сохранённой сверки");
  return result.data;
}
