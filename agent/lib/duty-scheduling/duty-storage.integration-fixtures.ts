/** Fictional records for the isolated PostgreSQL tests and the step-6 demo. */
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { database } from "../database.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { sha256Json } from "../json-hash.js";
import { parseDutyData } from "./duty-data.js";
import { parseDutyHistory } from "./duty-history.js";
import { DUTY_APPROVAL_TOOL, type DutyApprovalInput, type StoredDutyVersion } from "./duty-snapshot.js";

export function requireDutyTestDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.slice(1).endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Нужна отдельная DATABASE_URL с именем БД, оканчивающимся на _test");
  }
}

export async function createDutyFixture() {
  requireDutyTestDatabase();
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Учебные дежурства') RETURNING id");
  const familyId = family.rows[0].id;
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Владелец Примеров'), ($2, 'Участник Тестов') RETURNING id, telegram_user_id",
    [String(randomInt(100_000_000, 900_000_000)), String(randomInt(1_000_000_000, 2_000_000_000))],
  );
  const [owner, member] = users.rows;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [familyId, owner.id, member.id]);
  const group = await database().query<{ id: string }>(
    "INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode) VALUES ($1, $2, 'Учебная группа', 'external', 'addressed_only') RETURNING id",
    [familyId, `-100${randomInt(100_000_000, 900_000_000)}`],
  );
  const data = parseDutyData(JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/example.json", import.meta.url), "utf8")));
  const history = parseDutyHistory(JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/history.json", import.meta.url), "utf8")), data);
  const auth: PrivateTelegramOwner = { familyId, userId: owner.id, role: "owner", telegramChatId: owner.telegram_user_id };
  return {
    auth, member: { ...auth, userId: member.id, role: "member", telegramChatId: member.telegram_user_id } satisfies PrivateTelegramOwner,
    input: { groupId: group.rows[0].id, date: "2026-11-09", operationKey: randomUUID(), data, history },
    async cleanup() {
      await database().query("DELETE FROM conversation_sessions WHERE owner_user_id = $1", [owner.id]);
      await database().query("DELETE FROM families WHERE id = $1", [familyId]);
      await database().query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users.rows.map((user) => user.id)]);
    },
  };
}
export type DutyFixture = Awaited<ReturnType<typeof createDutyFixture>>;

export function approvalInput(stored: StoredDutyVersion): DutyApprovalInput {
  return { id: stored.id, contentHash: stored.contentHash, expectedApprovedId: stored.baseApprovedId };
}

/** Simulates an already consumed callback receipt; never sends Telegram requests. */
export async function recordDutyApproval(fixture: DutyFixture, input: unknown, toolName: string = DUTY_APPROVAL_TOOL) {
  requireDutyTestDatabase();
  const eveSessionId = `duty-test-${randomUUID()}`;
  const toolCallId = randomUUID();
  const session = await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, scope, kind, conversation_key, continuation_token, eve_session_id, started_at, last_activity_at)
     VALUES ($1, 0, $2, $3, 'personal', 'canonical', $4, $4, $4, now(), now()) RETURNING id`,
    [randomUUID(), fixture.auth.familyId, fixture.auth.userId, eveSessionId],
  );
  const applicationSessionId = session.rows[0].id;
  await database().query(
    `INSERT INTO telegram_hitl_approvals
       (application_session_id, eve_session_id, request_id, telegram_chat_id, telegram_chat_type,
        telegram_message_id, expected_telegram_user_id, callback_data, consumed_at,
        selected_option_id, selected_option_label, tool_call_id, tool_name, tool_input_hash, request_kind, prompt_text, callback_options)
     VALUES ($1, $2, $3, $4, 'private', $5, $4, ARRAY['approve'], now(), 'approve', 'Утвердить', $3, $6, $7, 'tool-approval', 'Учебное подтверждение', '[]'::jsonb)`,
    [applicationSessionId, eveSessionId, toolCallId, fixture.auth.telegramChatId, randomInt(1, 2_000_000_000), toolName, sha256Json(input)],
  );
  return { applicationSessionId, eveSessionId, toolCallId };
}
