/** Owner and live-profile checks wrap a read-only, exact-argv Sheets import. No real Google calls. */
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import { classifyGoogleWorkspaceCommand } from "../google-workspace/google-workspace-command-policy.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";
import { createDutySheetReader } from "./duty-sheet-reader.js";

function fixture() {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/sheets-example.json", import.meta.url), "utf8"));
  const source = createDutySheetSource("duty-example-sheet", "fixture-profile");
  const owner = { familyId: "fixture-family", userId: "fixture-owner", role: "owner" as const, telegramChatId: "101" };
  const requireOwner = vi.fn().mockReturnValue(owner);
  const withOwner = vi.fn(async (_owner, operation) => operation());
  const execute = vi.fn().mockResolvedValue({
    kind: "read", scope: "personal", profileRef: source.profileRef, completed: true, stdout: JSON.stringify(raw), stderr: "",
  });
  // Only abortSignal is exercised by the injected transport in these tests.
  const ctx = { abortSignal: new AbortController().signal } as ToolContext;
  const deps = { requireOwner, withOwner, execute };
  return { raw, source, owner, ctx, deps, read: createDutySheetReader(deps) };
}

describe("readDutySheet", () => {
  it("reads nine ranges without retaining the owner connection and rechecks before returning", async () => {
    const f = fixture();
    let locked = false;
    f.deps.withOwner.mockImplementationOnce(async (_owner, operation) => {
      locked = true;
      try { return await operation(); } finally { locked = false; }
    });
    f.deps.execute.mockImplementationOnce(async () => {
      expect(locked).toBe(false);
      return { kind: "read", scope: "personal", profileRef: f.source.profileRef, completed: true, stdout: JSON.stringify(f.raw) };
    });
    const result = await f.read(f.source, f.ctx);
    expect(result.owner).toEqual({ familyId: f.owner.familyId, userId: f.owner.userId });
    expect(result.counts.residents).toBe(10);
    expect(f.deps.withOwner).toHaveBeenCalledWith(f.owner, expect.any(Function));
    expect(f.deps.withOwner).toHaveBeenCalledTimes(2);
    expect(locked).toBe(false);
    expect(f.deps.execute).toHaveBeenCalledTimes(1);
    const [input, ctx] = f.deps.execute.mock.calls[0];
    expect(input.expectedProfileRef).toBe(f.source.profileRef);
    expect(ctx).toBe(f.ctx);
    expect(classifyGoogleWorkspaceCommand(input.argv)).toBe("read");
    expect(input.argv.slice(0, 5)).toEqual(["sheets", "spreadsheets", "values", "batchGet", "--params"]);
    expect(JSON.parse(input.argv[5])).toEqual({
      spreadsheetId: f.source.spreadsheetId, ranges: ["Жильцы", "Объекты", "Смены", "Календарь", "Исключения", "Настройки", "Доступность", "Графики", "Назначения"].map((sheet) => `'${sheet}'!A:Z`),
      majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING",
    });
  });

  it("rejects an untrusted/private-chat context before any Google access", async () => {
    const f = fixture();
    f.deps.requireOwner.mockImplementation(() => { throw new Error("AGENT_PRIVATE_CHAT_REQUIRED"); });
    await expect(f.read(f.source, f.ctx)).rejects.toThrow(/AGENT_PRIVATE_CHAT_REQUIRED/u);
    expect(f.deps.execute).not.toHaveBeenCalled();
    expect(f.deps.withOwner).not.toHaveBeenCalled();
  });

  it("does not read after owner access is revoked and propagates connection errors without retry", async () => {
    const f = fixture();
    f.deps.withOwner.mockRejectedValueOnce(new Error("AGENT_OWNER_REQUIRED"));
    await expect(f.read(f.source, f.ctx)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    expect(f.deps.execute).not.toHaveBeenCalled();
    f.deps.execute.mockRejectedValueOnce(new Error("AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY"));
    await expect(f.read(f.source, f.ctx)).rejects.toThrow(/AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY/u);
    expect(f.deps.execute).toHaveBeenCalledTimes(1);
  });

  it("does not return table contents after owner access is revoked during the Google read", async () => {
    const f = fixture();
    f.deps.execute.mockImplementationOnce(async () => {
      f.deps.withOwner.mockRejectedValueOnce(new Error("AGENT_OWNER_REQUIRED"));
      return { kind: "read", scope: "personal", profileRef: f.source.profileRef, completed: true, stdout: JSON.stringify(f.raw) };
    });
    await expect(f.read(f.source, f.ctx)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    expect(f.deps.withOwner).toHaveBeenCalledTimes(2);
    expect(f.deps.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { profileRef: "different-profile" }, { scope: "family" }, { kind: "mutation" }, { completed: false }, { stdout: "" }, { stdout: "{bad json" },
  ])("rejects unusable transport results: %j", async (override) => {
    const f = fixture();
    f.deps.execute.mockResolvedValueOnce({ kind: "read", scope: "personal", profileRef: f.source.profileRef, completed: true, stdout: JSON.stringify(f.raw), ...override });
    await expect(f.read(f.source, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_READ_INVALID/u);
  });

  it("freezes source and baseline values before the asynchronous read", async () => {
    const f = fixture();
    const previous = previewDutySheetImport(f.source, f.raw);
    f.deps.execute.mockImplementationOnce(async () => {
      f.source.mapping.residents.sheet = "Изменено во время чтения";
      previous.data.residents[0].lastName = "Изменено во время чтения";
      return { kind: "read", scope: "personal", profileRef: f.source.profileRef, completed: true, stdout: JSON.stringify(f.raw) };
    });
    const next = await f.read(f.source, f.ctx, previous);
    expect(next.changes).toEqual([]);
    expect(next.source.mapping.residents.sheet).toBe("Жильцы");
  });
});
