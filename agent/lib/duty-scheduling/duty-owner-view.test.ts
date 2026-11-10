/** A saved version supplies names and reasons; a later source change never recomputes its preview. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import tool from "../tools/manage_duty_schedule.js";
import { prepareDutyDraft } from "./duty-allocation.js";
import { parseDutyData } from "./duty-data.js";
import { parseDutyHistory } from "./duty-history.js";
import { dutyOwnerInputSchema, parseDutyOwnerInput } from "./duty-owner-input.js";
import { dutyOwnerView } from "./duty-owner-view.js";
import { hashDutyJson, type StoredDutyVersion } from "./duty-snapshot.js";

function stored(date = "2026-11-09"): StoredDutyVersion {
  const data = parseDutyData(JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/example.json", import.meta.url), "utf8")));
  const history = parseDutyHistory(JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/history.json", import.meta.url), "utf8")), data);
  const snapshot = { schemaVersion: 1 as const, id: randomUUID(), version: 1, familyId: randomUUID(), createdBy: randomUUID(), baseApprovedId: null,
    destination: { groupId: randomUUID(), telegramChatId: "-100123", title: "Учебный дом" }, data, history, draft: prepareDutyDraft(data, history, date) };
  return { id: snapshot.id, version: 1, date, status: "draft", contentHash: hashDutyJson(snapshot), baseApprovedId: null,
    createdAt: "2026-11-09T08:00:00.000Z", approvedAt: null, snapshot };
}

describe("duty owner preview", () => {
  it("shows the saved names, periods, team, workload and exact object assignments", () => {
    const version = stored();
    const before = structuredClone(version);
    const view = dutyOwnerView(version);
    expect(view).toMatchObject({ status: "draft", filledSlots: 6, unfilledSlots: 0, configuration: null, publicationPerformed: false, approvalPerformed: false });
    expect(view.previewText).toContain("Учебный дом");
    expect(view.previewText).toContain("Участники назначены вместе в одном периоде");
    for (const object of view.objects) for (const row of object.assignments) {
      expect(view.previewText).toContain(row.name);
      expect(row).toMatchObject(version.snapshot.draft.objects.find((item) => item.objectId === object.objectId)!.assignments.find((item) => item.residentId === row.residentId)!);
    }
    expect(view.previewText).toContain("2026-10-10 по 2026-11-08");
    expect(view.previewText).toContain("Нагрузка до назначения");
    expect(view).not.toHaveProperty("data");
    expect(view).not.toHaveProperty("history");
    expect(view).not.toHaveProperty("response");
    expect(version).toEqual(before);
  });

  it("reports unknown shifts and gaps using the saved explanations", () => {
    const view = dutyOwnerView(stored("2026-11-10"));
    expect(view.unfilledSlots).toBeGreaterThan(0);
    expect(view.missingShifts).toHaveLength(8);
    expect(view.previewText).toContain("Не загружены смены");
    expect(view.previewText).toContain("Не закрыто мест");
    expect(view.objects.some((row) => row.unfilledReason !== null)).toBe(true);
  });

  it("distinguishes approval from publication and disambiguates matching names", () => {
    const version = { ...stored(), status: "approved" as const };
    version.snapshot.data.residents.forEach((row) => { row.firstName = "Иван"; row.lastName = "Петров"; });
    const view = dutyOwnerView(version);
    expect(view.previewText).toContain("Утверждённая версия");
    expect(view.previewText).not.toContain("Опубликован");
    expect(view.objects.flatMap((row) => row.assignments).every((row) => row.name.includes(`(${row.residentId})`))).toBe(true);
  });

  it("supports older snapshots without a title and flattens untrusted display values", () => {
    const version = stored();
    const legacy = { ...version, snapshot: { ...version.snapshot, destination: { groupId: version.snapshot.destination.groupId, telegramChatId: version.snapshot.destination.telegramChatId } } };
    version.snapshot.data.residents[0].firstName = "Имя\n\u202eподмена";
    const view = dutyOwnerView(legacy);
    expect(view.previewText).toContain("Группа: -100123");
    expect(JSON.stringify(view)).not.toContain("\u202e");
    expect(view.objects.flatMap((row) => row.assignments).every((row) => !row.name.includes("\n"))).toBe(true);
  });

  it("rejects an oversized preview instead of silently dropping assignments", () => {
    const version = stored();
    const oversized = { ...version, snapshot: { ...version.snapshot, draft: { ...version.snapshot.draft, requiredSlots: 151 } } };
    expect(() => dutyOwnerView(oversized)).toThrow(/AGENT_DUTY_PREVIEW_TOO_LARGE/u);
  });
});

describe("duty owner input", () => {
  it("does not request publication approval for draft creation and denies unsupported actions", async () => {
    const policy = tool.approval as (ctx: never) => unknown;
    expect(policy({ toolInput: { action: "prepare", groupId: randomUUID(), date: "2026-11-09" } } as never)).toBe("not-applicable");
    expect(policy({ toolInput: { action: "publish", id: randomUUID() } } as never)).toMatchObject({ type: "denied" });
    await expect(tool.execute({ action: "prepare", source: {} } as never, {} as never)).rejects.toThrow(/AGENT_DUTY_OWNER_INPUT_INVALID/u);
  });
  it("uses an object-shaped descriptor and validates exact action fields", () => {
    const schema = z.toJSONSchema(dutyOwnerInputSchema);
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("oneOf");
    expect(parseDutyOwnerInput({ action: "groups" })).toEqual({ action: "groups" });
    expect(parseDutyOwnerInput({ action: "prepare", groupId: randomUUID(), date: "2026-11-09" }).action).toBe("prepare");
  });

  it.each([
    { action: "prepare" }, { action: "prepare", groupId: randomUUID(), date: "завтра" },
    { action: "prepare", groupId: randomUUID(), date: "2026-02-30" },
    { action: "groups", date: "2026-11-09" }, { action: "get", groupId: randomUUID() },
    { action: "latest", groupId: randomUUID() }, { action: "approve", id: randomUUID() },
    { action: "prepare", groupId: randomUUID(), date: "2026-11-09", source: {} },
    { action: "get", id: randomUUID(), familyId: randomUUID() },
  ])("denies invalid or injected arguments: %j", (input) => {
    expect(() => parseDutyOwnerInput(input)).toThrow(/AGENT_DUTY_OWNER_INPUT_INVALID/u);
  });
});
