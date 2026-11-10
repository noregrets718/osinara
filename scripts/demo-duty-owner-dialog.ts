/** Isolated test-database owner workflow; Google and Telegram identity are fictional dependencies. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { closeDatabase } from "../agent/lib/database.js";
import { createConfiguredDutySheetReader } from "../agent/lib/duty-scheduling/duty-configured-sheet.js";
import { listDutyOwnerGroups } from "../agent/lib/duty-scheduling/duty-owner-groups.js";
import { createDutyOwnerManager } from "../agent/lib/duty-scheduling/duty-owner-service.js";
import { dutyScheduleRepository } from "../agent/lib/duty-scheduling/duty-schedule-repository.js";
import { createDutySheetSource } from "../agent/lib/duty-scheduling/duty-sheet-format.js";
import { previewDutySheetImport } from "../agent/lib/duty-scheduling/duty-sheet-import.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository } from "../agent/lib/duty-scheduling/duty-sheet-source-repository.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase } from "../agent/lib/duty-scheduling/duty-storage.integration-fixtures.js";

requireDutyTestDatabase();
let family: Awaited<ReturnType<typeof createDutyFixture>> | undefined;
try {
  const f = await createDutyFixture(); family = f;
  const source = createDutySheetSource("duty-example-sheet", randomUUID());
  const configure = { operationId: randomUUID(), groupId: f.input.groupId, expectedVersion: 0, source };
  await dutySheetSourceRepository.save(f.auth, configure, await recordDutyApproval(f, configure, DUTY_SOURCE_TOOL));
  const remote = JSON.parse(readFileSync(new URL("../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  let reads = 0;
  // Production uses requirePrivateTelegramOwner; only this *_test demo supplies a fictional actor.
  const owner = () => f.auth;
  const load = createConfiguredDutySheetReader({ owner, sources: dutySheetSourceRepository, read: async (selected) => {
    reads++;
    return { ...previewDutySheetImport(selected, remote), response: remote, owner: { familyId: f.auth.familyId, userId: f.auth.userId } };
  } });
  const manage = createDutyOwnerManager({ owner, groups: listDutyOwnerGroups, load, schedules: dutyScheduleRepository });
  const ctx = { callId: randomUUID(), abortSignal: new AbortController().signal,
    session: { id: randomUUID(), auth: { current: null, initiator: null }, turn: { id: randomUUID(), sequence: 1 } } } as unknown as ToolContext;
  const groups = await manage({ action: "groups" }, ctx);
  if (!("groups" in groups) || !groups.groups) throw new Error("Expected group list");
  console.log(`Доступных групп: ${groups.groups.length}`);
  const request = { action: "prepare", groupId: f.input.groupId, date: "2026-11-09" };
  const version = await manage(request, ctx);
  if (!("previewText" in version)) throw new Error("Expected duty preview");
  console.log(version.previewText);
  await closeDatabase();
  const restored = await manage({ action: "get", id: version.id }, ctx);
  const replay = await manage(request, ctx);
  console.log(`После переподключения та же версия: ${"id" in restored && restored.id === version.id}`);
  console.log(`Повтор использовал снимок: ${"reused" in replay && replay.reused}; чтений Google-модели: ${reads}`);
  console.log("Утверждение и публикация не выполнялись. Реальных Google/Telegram-запросов нет.");
} finally {
  try { await family?.cleanup(); } finally { await closeDatabase(); }
}
