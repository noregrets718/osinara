/** Strict action schemas, approval policies and confirmation wiring. */
import { randomUUID } from "node:crypto";
import type { SessionContext } from "eve/context";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import inspectTool from "../tools/inspect_duty_sheet_changes.js";
import applyTool from "../tools/apply_duty_sheet_changes.js";
import { createTelegramApprovalPresenter } from "../telegram-hitl/approval-presentation.js";
import { dutyApplyPreviewSchema, dutyEditDialogSchema, parseDutyApplyPreview, parseDutyEditDialog } from "./duty-edit-input.js";

describe("duty edit tool contracts", () => {
  it.each([
    { action: "preview", groupId: randomUUID(), edits: [] },
    { action: "read", groupId: randomUUID(), section: "assignments" },
    { action: "read", groupId: randomUUID(), section: "residents", source: {} },
    { action: "status", operationId: randomUUID(), groupId: randomUUID() },
    { action: "preview", groupId: randomUUID(), edits: [{ section: "residents", key: "r01", action: "remove" }] },
  ])("rejects unsupported or injected inputs: %j", (raw) => {
    expect(() => parseDutyEditDialog(raw)).toThrow(/EDIT_INPUT_INVALID/u);
  });
  it("exposes an object-shaped schema and only an ID for approval", () => {
    expect(z.toJSONSchema(dutyEditDialogSchema).type).toBe("object");
    expect(Object.keys(z.toJSONSchema(dutyApplyPreviewSchema).properties!)).toEqual(["previewId"]);
    expect(() => parseDutyApplyPreview({ previewId: randomUUID(), edits: [] })).toThrow(/EDIT_INPUT_INVALID/u);
    const policy = (tool: unknown) => (tool as { approval: (ctx: { toolInput: unknown }) => unknown }).approval;
    expect(policy(inspectTool)({ toolInput: { action: "read", groupId: randomUUID(), section: "settings" } })).toBe("not-applicable");
    expect(policy(applyTool)({ toolInput: { previewId: randomUUID() } })).toBe("user-approval");
    expect(policy(applyTool)({ toolInput: {} })).toMatchObject({ type: "denied" });
  });
  it("renders the trusted saved prompt without changing IDs or the executed request", async () => {
    const findDutyEdits = vi.fn(async () => "Настройки, lookbackDays: 30 → 14");
    const present = createTelegramApprovalPresenter({ findDutyEdits, findBrowserConfirm: vi.fn(), findGmailMessage: vi.fn(), findSchedule: vi.fn() });
    const request = { action: { kind: "tool-call" as const, toolName: "apply_duty_sheet_changes", callId: "c", input: { previewId: randomUUID() } },
      requestId: "r", prompt: "Approve", display: "confirmation" as const, options: [{ id: "approve", label: "Yes", style: "primary" as const }] };
    const result = await present(request, { session: {} } as SessionContext);
    expect(result.prompt).toBe("Настройки, lookbackDays: 30 → 14");
    expect(result.action).toEqual(request.action); expect(result.requestId).toBe("r");
    expect(result.options).toMatchObject([{ id: "approve", label: "Записать правки" }]);
  });
});
