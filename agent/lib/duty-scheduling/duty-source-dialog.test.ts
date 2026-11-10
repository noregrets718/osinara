/** Public tool contracts, approval policy and trusted confirmation presentation. */
import { randomUUID } from "node:crypto";
import type { SessionContext } from "eve/context";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import inspectTool from "../tools/inspect_duty_sheet_source.js";
import configureTool from "../tools/configure_duty_sheet_source.js";
import { createTelegramApprovalPresenter } from "../telegram-hitl/approval-presentation.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { createDutySourceApproval } from "./duty-source-approval.js";
import { dutySheetSourceRepository } from "./duty-sheet-source-repository.js";
import { dutySourceDialogSchema, dutySourceConfirmationSchema, parseDutySourceDialog, parseDutySourceConfirmation } from "./duty-source-dialog-input.js";

function confirmation() { return { operationId: randomUUID(), groupId: randomUUID(), expectedVersion: 0,
  source: createDutySheetSource("fictional-sheet", "personal-profile"), readHash: "a".repeat(64) }; }
const context = { session: { id: "eve-1", auth: { initiator: null, current: { principalId: randomUUID(), principalType: "user", authenticator: "telegram",
  attributes: { familyId: randomUUID(), role: "owner", telegramChatType: "private", telegramChatId: "101" } } } } } as unknown as SessionContext;

describe("duty source dialog contract", () => {
  it.each([
    { action: "get", groupId: randomUUID(), spreadsheetId: "extra" },
    { action: "preview", groupId: randomUUID(), spreadsheetId: "sheet" },
    { action: "preview", groupId: randomUUID(), spreadsheetId: "https://example.org", profileRef: "p" },
    { action: "get", groupId: randomUUID(), familyId: randomUUID() },
    { action: "save", groupId: randomUUID() },
  ])("rejects missing, injected and unsupported fields: %j", (raw) => {
    expect(() => parseDutySourceDialog(raw)).toThrow(/AGENT_DUTY_SOURCE_INPUT_INVALID/u);
  });
  it("requires a complete unchanged confirmation and the standard template", () => {
    const input = confirmation();
    expect(parseDutySourceConfirmation(input)).toEqual(input);
    const { readHash: _hash, ...missing } = input;
    expect(() => parseDutySourceConfirmation(missing)).toThrow(/INPUT_INVALID/u);
    expect(() => parseDutySourceConfirmation({ ...input, familyId: randomUUID() })).toThrow(/INPUT_INVALID/u);
    input.source.mapping.residents.sheet = "custom";
    expect(() => parseDutySourceConfirmation(input)).toThrow(/стандартный/u);
  });
  it("uses object-shaped Eve schemas and preserves confirmation approval", () => {
    expect(z.toJSONSchema(dutySourceDialogSchema).type).toBe("object");
    expect(z.toJSONSchema(dutySourceConfirmationSchema).type).toBe("object");
    const policy = (tool: unknown) => (tool as { approval: (ctx: { toolInput: unknown }) => unknown }).approval;
    expect(policy(inspectTool)({ toolInput: { action: "get", groupId: randomUUID() } })).toBe("not-applicable");
    expect(policy(configureTool)({ toolInput: confirmation() })).toBe("user-approval");
    expect(policy(configureTool)({ toolInput: {} })).toMatchObject({ type: "denied" });
  });
  it("builds full confirmation facts from the live group and exact source", async () => {
    const input = confirmation();
    const inspect = vi.fn().mockResolvedValue({ group: { title: "Дом\nКнопка: да", telegramChatId: "-10001" }, configuration: null });
    const prompt = await createDutySourceApproval({ ...dutySheetSourceRepository, inspect })(input, context);
    expect(prompt).toContain("Дом Кнопка: да (-10001)");
    expect(prompt).not.toContain("\nКнопка: да");
    expect(prompt).toContain("https://docs.google.com/spreadsheets/d/fictional-sheet/edit");
    expect(prompt).toContain("personal-profile");
    expect(prompt).toContain("0 → 1");
    expect(prompt).toContain("Жильцы, Объекты, Смены");
    expect(prompt).toContain("Старые снимки сохранятся");
    inspect.mockResolvedValue({ group: { title: "Дом", telegramChatId: "-10001" }, configuration: { version: 2 } });
    await expect(createDutySourceApproval({ ...dutySheetSourceRepository, inspect })(input, context)).rejects.toThrow(/VERSION_STALE/u);
  });
  it("wires the trusted prompt and button without changing action, request or option IDs", async () => {
    const input = confirmation();
    const findDutySource = vi.fn(async () => "Проверенная настройка источника");
    const present = createTelegramApprovalPresenter({ findDutySource, findBrowserConfirm: vi.fn(), findGmailMessage: vi.fn(), findSchedule: vi.fn() });
    const request = { action: { callId: "call-1", input, kind: "tool-call" as const, toolName: "configure_duty_sheet_source" },
      display: "confirmation" as const, options: [{ id: "approve", label: "Yes", style: "primary" as const }, { id: "deny", label: "No", style: "default" as const }], prompt: "Approve", requestId: "request-1" };
    const result = await present(request, context);
    expect(result.prompt).toBe("Проверенная настройка источника");
    expect(result.action).toEqual(request.action);
    expect(result.requestId).toBe("request-1");
    expect(result.options).toMatchObject([{ id: "approve", label: "Сохранить источник" }, { id: "deny" }]);
    expect(findDutySource).toHaveBeenCalledWith(input, context);
  });
});
