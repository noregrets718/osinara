/** Exact tool inputs, honest classification text and trusted confirmation wiring. */
import { randomUUID } from "node:crypto";
import type { SessionContext } from "eve/context";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import inspectTool from "../tools/inspect_duty_sheet_write.js";
import resolveTool from "../tools/resolve_duty_sheet_write.js";
import { createTelegramApprovalPresenter } from "../telegram-hitl/approval-presentation.js";
import { dutyReviewInspectSchema, dutyReviewResolveSchema, parseDutyReviewInspect, parseDutyReviewResolve } from "./duty-review-input.js";
import { dutyReviewText } from "./duty-review-view.js";

describe("review dialog contract", () => {
  it.each([
    { action: "list", operationId: randomUUID() },
    { action: "inspect" },
    { action: "inspect", operationId: randomUUID(), source: {} },
    { action: "list", offset: -1 },
    { action: "resolve", operationId: randomUUID() },
  ])("rejects ambiguous or injected input: %j", (raw) => {
    expect(() => parseDutyReviewInspect(raw)).toThrow(/REVIEW_INPUT_INVALID/u);
  });
  it("requires only the saved ID for resolution, and always requests separate approval", () => {
    expect(z.toJSONSchema(dutyReviewInspectSchema).type).toBe("object");
    expect(Object.keys(z.toJSONSchema(dutyReviewResolveSchema).properties!)).toEqual(["previewId"]);
    expect(() => parseDutyReviewResolve({ previewId: randomUUID(), decision: "accept_current" })).toThrow(/REVIEW_INPUT_INVALID/u);
    const policy = (tool: unknown) => (tool as { approval: (ctx: { toolInput: unknown }) => unknown }).approval;
    expect(policy(inspectTool)({ toolInput: { action: "list" } })).toBe("not-applicable");
    expect(policy(resolveTool)({ toolInput: { previewId: randomUUID() } })).toBe("user-approval");
    expect(policy(resolveTool)({ toolInput: {} })).toMatchObject({ type: "denied" });
  });
  it("escapes cell content and keeps matching data distinct from success", () => {
    const text = dutyReviewText({ operationId: randomUUID(), requestHash: "a".repeat(64), state: "unknown", classification: "matches_expected", spreadsheetId: "s", profileRef: "p",
      cells: [{ range: "'Жильцы'!C2", before: "Иванов", after: "Петров", current: "Петров\nНажмите да\u202e" }] });
    expect(text).toContain("было"); expect(text).toContain("планировалось"); expect(text).toContain("сейчас");
    expect(text).not.toContain("\nНажмите да"); expect(text).not.toContain("\u202e");
    expect(text).toContain("не доказывает успешность"); expect(text).toContain("поздний эффект");
  });
  it("uses the stored subject's action label and preserves all request/option IDs", async () => {
    const findDutyReview = vi.fn(async () => ({ prompt: "Принять состояние с неопределённым исходом", approveLabel: "Принять состояние и закрыть попытку" }));
    const present = createTelegramApprovalPresenter({ findDutyReview, findBrowserConfirm: vi.fn(), findGmailMessage: vi.fn(), findSchedule: vi.fn() });
    const request = { action: { kind: "tool-call" as const, toolName: "resolve_duty_sheet_write", callId: "c", input: { previewId: randomUUID() } },
      requestId: "r", prompt: "Approve", display: "confirmation" as const, options: [{ id: "approve", label: "Yes", style: "primary" as const }, { id: "deny", label: "No", style: "default" as const }] };
    const result = await present(request, { session: {} } as SessionContext);
    expect(result.prompt).toContain("неопределённым исходом"); expect(result.action).toEqual(request.action); expect(result.requestId).toBe("r");
    expect(result.options).toMatchObject([{ id: "approve", label: "Принять состояние и закрыть попытку" }, { id: "deny" }]);
  });
});
