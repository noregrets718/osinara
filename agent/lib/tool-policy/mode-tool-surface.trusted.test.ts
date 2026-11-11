/**
 * Mode-scoped tool surface tests: the trusted zones.
 *
 * Constructs covered:
 * - Each trust zone emits exactly its own application tools and nothing from another zone.
 * - HITL approval configuration survives dynamic emission.
 * - Native subagents cannot make root-owned durable-memory decisions.
 * External groups live in `mode-tool-surface.test.ts` (split to keep both under 500 lines).
 */
import { bash as nativeBash, glob as nativeGlob, grep as nativeGrep, readFile as nativeReadFile, webFetch as eveWebFetch, writeFile as nativeWriteFile } from "eve/tools/defaults";
import { describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

// The trusted matrix under test includes the Google tools, which exist only with OAuth credentials.
vi.mock("../google-workspace/google-workspace-availability.js", () => ({
  GOOGLE_WORKSPACE_AVAILABLE: true,
}));
vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

import { FAMILY_ONLY_TOOL_NAMES, PRIVATE_ONLY_TOOL_NAMES, TRUSTED_MODE_TOOL_NAMES, buildModeToolSurface, buildSubagentToolSurface } from "./mode-tool-surface.js";
import { TRUSTED_MODE_TOOLS } from "./trusted-mode-tool-catalog.js";
import { TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES } from "../turn-interjection/turn-interjection-surface.js";
import { FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS } from "./group-tool-catalog.js";

function names(input: Parameters<typeof buildModeToolSurface>[0]): string[] {
  return Object.keys(buildModeToolSurface(input)).sort();
}

describe("trusted mode tool surfaces", () => {
  it.each(["manage_duty_schedule", "inspect_duty_sheet_source", "configure_duty_sheet_source", "inspect_duty_sheet_changes", "apply_duty_sheet_changes"])("keeps %s in the interactive private root surface only", (name) => {
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty(name);
    expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty(name);
    expect(buildModeToolSurface({ capabilities: new Set(), environment: "external" })).not.toHaveProperty(name);
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty(name);
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty(name);
  });
  it("gives a private chat the shared tools plus owner administration only", () => {
    expect(names({ environment: "private" })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES, ...TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES].sort(),
    );
    expect(names({ environment: "private" })).toContain("manage_external_group_schedule");
  });

  it("exposes R3 profile policy and provenance only in the intended trust zones", () => {
    const privateNames = names({ environment: "private" });
    const familyNames = names({ environment: "family" });
    const externalNames = names({
      capabilities: new Set(),
      environment: "external",
    });

    expect(privateNames).toEqual(
      expect.arrayContaining(["get_memory_source", "list_memory_threads", "manage_memory_thread", "manage_profile_projection", "read_memory_thread", "read_profile_view", "search_memory_threads"]),
    );
    expect(familyNames).toEqual(expect.arrayContaining(["list_memory_threads", "manage_memory_thread", "read_memory_thread", "read_profile_view", "search_memory_threads"]));
    expect(familyNames).not.toContain("get_memory_source");
    expect(externalNames).toEqual(expect.arrayContaining(["read_profile_view"]));
  });

  it("gives a family group the shared tools plus group history and attachments only", () => {
    expect(names({ environment: "family" })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES, ...TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES].sort(),
    );
    expect(names({ environment: "family" })).not.toContain("manage_external_group_schedule");
  });

  it("exposes the run-bound history reader only to a scheduled external turn", () => {
    const ordinary = names({
      capabilities: new Set(),
      environment: "external",
    });
    const scheduled = names({
      capabilities: new Set(),
      environment: "external",
      scheduledHistory: true,
    } as never);

    expect(ordinary).not.toContain("read_scheduled_group_history");
    expect(scheduled).toContain("read_scheduled_group_history");
    expect(scheduled).toContain("agent");
  });

  it("never exposes another zone's tools", () => {
    const privateNames = names({ environment: "private" });
    const familyNames = names({ environment: "family" });

    for (const familyOnly of FAMILY_ONLY_TOOL_NAMES) {
      expect(privateNames, `private must not expose ${familyOnly}`).not.toContain(familyOnly);
    }
    for (const privateOnly of PRIVATE_ONLY_TOOL_NAMES) {
      expect(familyNames, `family must not expose ${privateOnly}`).not.toContain(privateOnly);
    }
  });

  it("emits no denial stubs in a trusted zone", () => {
    for (const environment of ["private", "family"] as const) {
      const surface = buildModeToolSurface({ environment });
      for (const denied of FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS) {
        // Trusted web_fetch keeps its executor; DeepSeek web_search gets a local executor.
        if (denied === "web_fetch" || denied === "web_search") continue;
        // Bash is re-emitted only as Eve's own tool so its results can carry waiting messages.
        if (denied === "bash") {
          expect(surface.bash?.description, `${environment} must keep the native bash`).toBe(nativeBash.description);
          continue;
        }
        expect(names({ environment }), `${environment} must not override ${denied}`).not.toContain(denied);
      }
    }
  });

  it("re-emits native sandbox tools unchanged in interactive trusted zones only", () => {
    const native = { bash: nativeBash, glob: nativeGlob, grep: nativeGrep, read_file: nativeReadFile, write_file: nativeWriteFile };
    for (const environment of ["private", "family"] as const) {
      const surface = buildModeToolSurface({ environment });
      for (const [name, definition] of Object.entries(native)) {
        expect(surface[name]?.description, `${environment}.${name}`).toBe(definition.description);
        expect(surface[name]?.inputSchema, `${environment}.${name}`).toBe(definition.inputSchema);
      }
      const scheduled = buildModeToolSurface({ environment, scheduledRun: true });
      for (const name of TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES) expect(scheduled).not.toHaveProperty(name);
    }
  });

  it("re-describes web_fetch in a trusted zone without replacing Eve's executor", () => {
    for (const environment of ["private", "family"] as const) {
      const surface = buildModeToolSurface({ environment });
      const tool = surface.web_fetch as unknown as { description: string; execute: unknown };
      expect(tool.description).toContain("web_search");
      expect(typeof tool.execute).toBe("function");
    }
    // The catalog entry spreads Eve's definition, so the executor is Eve's own before wrapping.
    {
      const catalogTool = TRUSTED_MODE_TOOLS.web_fetch as unknown as { execute: unknown; inputSchema: unknown };
      const eve = eveWebFetch as unknown as { execute: unknown; inputSchema: unknown };
      expect(catalogTool.execute).toBe(eve.execute);
      expect(catalogTool.inputSchema).toBe(eve.inputSchema);
    }
  });

  it("keeps HITL approval configuration after dynamic emission", () => {
    const surface = buildModeToolSurface({ environment: "private" });

    for (const toolName of ["manage_reminder", "manage_agent_schedule", "manage_family_invitation", "manage_gmail_message"]) {
      expect((surface[toolName] as unknown as { approval?: unknown }).approval, `${toolName} must keep its approval policy`).toBeDefined();
    }
  });

  it("keeps the authored-skill library to interactive trusted roots", () => {
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ environment: "family" })).toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("manage_skill");
    expect(buildSubagentToolSurface({ environment: "family" })).not.toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ capabilities: new Set(), environment: "external" })).not.toHaveProperty("manage_skill");
    expect(buildModeToolSurface({ environment: "family" }).manage_skill?.approval).toBeTypeOf("function");
  });

  it("keeps root-owned durable writes off subagents", () => {
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("remember");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("remember");
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("manage_behavior_preference");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("manage_behavior_preference");
    expect(
      buildSubagentToolSurface({
        capabilities: new Set(["remember"]),
        environment: "external",
      }),
    ).not.toHaveProperty("remember");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("manage_behavior_preference");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true })).not.toHaveProperty("remember");
    expect(
      buildModeToolSurface({
        capabilities: new Set(["remember"]),
        environment: "external",
        scheduledRun: true,
      }),
    ).not.toHaveProperty("remember");
  });
});
