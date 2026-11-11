/** Exact model input, trusted prompt delivery and mandatory separate approval. */
import { randomUUID } from "node:crypto";
import type { SessionContext } from "eve/context";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import approveTool from "../tools/approve_duty_schedule.js";
import { createTelegramApprovalPresenter } from "../telegram-hitl/approval-presentation.js";
import { parseDutyApprovalRequest } from "./duty-approval-dialog.js";
import { dutyApprovalInputSchema } from "./duty-snapshot.js";
const input = () => ({ id: randomUUID(), contentHash: "a".repeat(64), expectedApprovedId: null });
describe("schedule approval tool contract", () => {
  it.each([
    { id: randomUUID() },
    { ...input(), groupId: randomUUID() },
    { ...input(), assignments: [] },
    { ...input(), contentHash: "invented" },
    { ...input(), expectedApprovedId: "latest" },
  ])("rejects incomplete or injected arguments: %j", (raw) => {
    expect(() => parseDutyApprovalRequest(raw)).toThrow(/APPROVAL_INPUT_INVALID/u);
  });
  it("uses an exact object schema and always asks for personal confirmation", () => {
    expect(z.toJSONSchema(dutyApprovalInputSchema).type).toBe("object");
    expect(Object.keys(z.toJSONSchema(dutyApprovalInputSchema).properties!)).toEqual(["id", "contentHash", "expectedApprovedId"]);
    const approval = (approveTool as unknown as { approval: (ctx: { toolInput: unknown }) => unknown }).approval;
    expect(approval({ toolInput: input() })).toBe("user-approval");
    expect(approval({ toolInput: {} })).toMatchObject({ type: "denied" });
  });
  it("shows the trusted version text while preserving exact request and button IDs", async () => {
    const findDutyScheduleApproval = vi.fn(async () => "Версия 2: сохранённые назначения и правила");
    const present = createTelegramApprovalPresenter({ findDutyScheduleApproval, findBrowserConfirm: vi.fn(), findGmailMessage: vi.fn(), findSchedule: vi.fn() });
    const request = { action: { kind: "tool-call" as const, toolName: "approve_duty_schedule", callId: "c", input: input() },
      requestId: "r", prompt: "Approve", display: "confirmation" as const, options: [{ id: "approve", label: "Yes", style: "primary" as const }, { id: "deny", label: "No", style: "default" as const }] };
    const result = await present(request, { session: {} } as SessionContext);
    expect(result.prompt).toBe("Версия 2: сохранённые назначения и правила"); expect(result.action).toEqual(request.action); expect(result.requestId).toBe("r");
    expect(result.options).toMatchObject([{ id: "approve", label: "Утвердить показанную версию" }, { id: "deny" }]);
  });
});
