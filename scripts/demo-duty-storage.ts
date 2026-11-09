/** Step 6 demonstration: temporary fictional records in an explicitly separate *_test database. */
import { randomUUID } from "node:crypto";

import { closeDatabase } from "../agent/lib/database.js";
import { dutyScheduleRepository as repository } from "../agent/lib/duty-scheduling/duty-schedule-repository.js";
import { approvalInput, createDutyFixture, recordDutyApproval, requireDutyTestDatabase } from "../agent/lib/duty-scheduling/duty-storage.integration-fixtures.js";

requireDutyTestDatabase();
let fixture: Awaited<ReturnType<typeof createDutyFixture>> | undefined;
try {
  fixture = await createDutyFixture();
  const first = await repository.save(fixture.auth, fixture.input);
  const replay = await repository.save(fixture.auth, fixture.input);
  console.log(`Версия ${first.version}, статус ${first.status}, мест ${first.snapshot.draft.filledSlots}/${first.snapshot.draft.requiredSlots}`);
  console.log(`Контрольная сумма: ${first.contentHash}`);
  console.log(`Повтор команды вернул тот же ID: ${replay.id === first.id}`);
  await closeDatabase();
  const restored = await repository.get(fixture.auth, first.id);
  console.log(`После переподключения: версия ${restored.version}, та же сумма: ${restored.contentHash === first.contentHash}`);

  // A test receipt represents a consumed owner callback; this script makes no Telegram calls.
  const input = approvalInput(first);
  await repository.approve(fixture.auth, input, await recordDutyApproval(fixture, input));
  fixture.input.data.rules.version = "example-rules-2";
  fixture.input.data.exceptions.push({ residentId: "r01", date: fixture.input.date, morning: false, evening: false });
  const second = await repository.save(fixture.auth, { ...fixture.input, operationKey: randomUUID() });
  const next = approvalInput(second);
  await repository.approve(fixture.auth, next, await recordDutyApproval(fixture, next));
  console.log(`После исправления: v1 — ${(await repository.get(fixture.auth, first.id)).status}, v2 — approved`);
  const history = await repository.history(fixture.auth, fixture.input.groupId, fixture.input.data, fixture.input.history);
  if (history.mode !== "not_loaded") {
    const effective = history.schedules.filter((row) => row.date === fixture!.input.date && row.status === "approved");
    console.log(`Действующих версий на дату: ${effective.length}; назначений в учёте: ${effective.flatMap((row) => row.assignments).length}`);
  }
} finally {
  try {
    await fixture?.cleanup();
  } finally {
    await closeDatabase();
  }
}
