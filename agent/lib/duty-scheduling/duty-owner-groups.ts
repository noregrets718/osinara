/** Owner-private discovery of external groups and their configured source versions. */
import type { PrivateTelegramOwner } from "../family-context.js";
import { withDutyOwner } from "./duty-storage.js";

export async function listDutyOwnerGroups(auth: PrivateTelegramOwner) {
  return withDutyOwner(auth, async (client) => {
    const result = await client.query<{ id: string; title: string; telegram_chat_id: string; source_id: string | null; source_version: number | null }>(
      `SELECT g.id, g.title, g.telegram_chat_id, s.id AS source_id, s.version AS source_version
       FROM telegram_groups g LEFT JOIN LATERAL (
         SELECT id, version FROM duty_sheet_sources WHERE group_id = g.id AND family_id = g.family_id ORDER BY version DESC LIMIT 1
       ) s ON true WHERE g.family_id = $1 AND g.type = 'external' ORDER BY g.title, g.id`, [auth.familyId],
    );
    return result.rows.map((row) => ({ groupId: row.id, title: row.title, telegramChatId: row.telegram_chat_id,
      configured: row.source_id !== null, sourceVersion: row.source_version }));
  });
}
