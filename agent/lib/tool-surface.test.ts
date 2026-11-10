/**
 * Agent capability surface regression tests.
 *
 * Constructs:
 * - `agent/tools` holds only the dynamic resolver; native `agent` supplies fresh-context delegation.
 * - Exact application tool-module allowlist after CRUD consolidation.
 * - Exact static package directories plus lifecycle-scoped dynamic resolvers.
 * - The compiled dynamic resolver stays step-scoped and avoids durable helper-closure replay.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const AGENT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_TOOL_MODULES = [
  "browser_act.ts",
  "browser_confirm.ts",
  "browser_look.ts",
  "browser_open.ts",
  "browser_read.ts",
  "browser_session.ts",
  "configure_duty_sheet_source.ts",
  "execute_google_workspace.ts",
  "export_memory.ts",
  "fetch_telegram_avatars.ts",
  "find_fuel_stations.ts",
  "generate_image.ts",
  "get_current_time.ts",
  "get_memory_source.ts",
  "grocery_cart.ts",
  "import_telegram_attachment.ts",
  "inspect_duty_sheet_source.ts",
  "inspect_workspace_image.ts",
  "list_agent_schedules.ts",
  "list_group_history.ts",
  "list_memories.ts",
  "list_memory_threads.ts",
  "list_pending_family_invitations.ts",
  "list_proactive_deliveries.ts",
  "list_reminders.ts",
  "list_telegram_attachments.ts",
  "manage_agent_schedule.ts",
  "manage_behavior_preference.ts",
  "manage_duty_schedule.ts",
  "manage_external_group_schedule.ts",
  "manage_family_invitation.ts",
  "manage_gmail_message.ts",
  "manage_google_workspace_connection.ts",
  "manage_memory.ts",
  "manage_memory_conflict.ts",
  "manage_memory_thread.ts",
  "manage_profile_projection.ts",
  "manage_reminder.ts",
  "manage_shopping_list.ts",
  "manage_skill.ts",
  "manage_telegram_group.ts",
  "notification_settings.ts",
  "read_memory_thread.ts",
  "read_profile_view.ts",
  "read_scheduled_group_history.ts",
  "remember.ts",
  "review_improvements.ts",
  "search_memories.ts",
  "search_memory_threads.ts",
  "send_widget.ts",
  "send_workspace_file.ts",
  "send_workspace_image.ts",
  "start_new_context.ts",
  "web_search.ts",
  "yandex_lavka.ts",
  "yandex_taxi.ts",
] as const;

const EXPECTED_DISCOVERED_TOOL_FILES = ["capabilities.ts"] as const;

// A family assistant ships no developer-docs lookup and no brokerage skill by default; the
// brokerage package is restorable from git history when a household actually uses T-Invest.
const EXPECTED_SKILL_DIRECTORIES = [
  "agent-browser",
  "auto-analyst",
  "behavior-preferences",
  "car-diagnostics",
  "docx",
  "pdf",
  "policy-finance-analyst",
  "skill-authoring",
  "xlsx",
] as const;

describe("agent capability surface", () => {
  it("discovers only the dynamic resolver so Eve provides native delegation", async () => {
    const entries = await readdir(`${AGENT_ROOT}/tools`, { withFileTypes: true });
    const toolFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolFiles).toEqual([...EXPECTED_DISCOVERED_TOOL_FILES]);
  });

  it("keeps every application tool implementation outside Eve discovery", async () => {
    const entries = await readdir(`${AGENT_ROOT}/lib/tools`, { withFileTypes: true });
    const toolModules = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolModules).toEqual([...EXPECTED_TOOL_MODULES]);
  });

  it("keeps static packages separate from the dynamic policy resolver", async () => {
    const entries = await readdir(`${AGENT_ROOT}/skills`, { withFileTypes: true });
    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillDirectories).toEqual([...EXPECTED_SKILL_DIRECTORIES]);
    const skillFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();
    expect(skillFiles).toEqual(["authored.ts", "external.ts", "scoped.ts"]);
  });

  it("requires every native skill package to declare SKILL.md", async () => {
    await Promise.all(
      EXPECTED_SKILL_DIRECTORIES.map(async (skillName) => {
        const files = await readdir(`${AGENT_ROOT}/skills/${skillName}`);

        expect(files).toContain("SKILL.md");
      }),
    );
  });

  it("authors the whole dynamic tool surface at step scope", async () => {
    const source = await readFile(`${AGENT_ROOT}/tools/capabilities.ts`, "utf8");

    expect(source).toContain('"step.started": (_event, ctx) => timed(');
    expect(source).not.toContain('"turn.started"');
  });
});
