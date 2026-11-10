/**
 * Mode-scoped executable tool surface.
 *
 * Exports:
 * - `ModeToolSurfaceInput`: verified facts a tool surface may be built from.
 * - `TRUSTED_MODE_TOOL_NAMES`, `PRIVATE_ONLY_TOOL_NAMES`, `FAMILY_ONLY_TOOL_NAMES`: the matrix.
 * - `buildModeToolSurface`: the exact root-agent tool map for one verified turn.
 * - `buildSubagentToolSurface`: the same trust zone without root-owned durable writes.
 *
 * Key constructs:
 * - Application tools are emitted per mode instead of authored statically, so a tool that cannot
 *   work in the current trust zone has no descriptor at all rather than a denial stub.
 * - External groups additionally deny the framework built-ins Eve always registers, and re-check
 *   every granted capability at execution time against the live database policy.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION } from "../image-generation/image-generation-tool-presentation.js";
import { wrapModelFacingToolMap } from "../model-facing-tool.js";
import { withTurnInterjectionSurface } from "../turn-interjection/turn-interjection-surface.js";
import { authorizeAgentScheduleDelivery } from "../agent-schedules/agent-schedule-delivery-authorization.js";
import { scheduledDeliveryMetadata } from "../agent-schedules/scheduled-session.js";
import { externalGroupLoadSkillTool } from "../group-skills/group-load-skill-tool.js";
import { MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT, THREAD_HISTORY_PAGE_MAX_ENTRIES } from "../memory-config.js";
import { THREAD_REF_PATTERN } from "../memory-thread-query-repository.js";
import { externalRememberInputSchema } from "../remember-contract.js";
import fetchTelegramAvatars from "../tools/fetch_telegram_avatars.js";
import generateImage from "../tools/generate_image.js";
import importTelegramAttachment from "../tools/import_telegram_attachment.js";
import inspectWorkspaceImage from "../tools/inspect_workspace_image.js";
import listGroupHistory from "../tools/list_group_history.js";
import listMemories from "../tools/list_memories.js";
import listMemoryThreads from "../tools/list_memory_threads.js";
import manageBehaviorPreference from "../tools/manage_behavior_preference.js";
import manageMemory, {
  MANAGE_MEMORY_ACTIONS,
  manageMemoryPresentation,
  type ManageMemoryAction,
} from "../tools/manage_memory.js";
import manageMemoryConflict from "../tools/manage_memory_conflict.js";
import manageMemoryThread from "../tools/manage_memory_thread.js";
import remember from "../tools/remember.js";
import readMemoryThread from "../tools/read_memory_thread.js";
import readScheduledGroupHistory from "../tools/read_scheduled_group_history.js";
import readProfileView from "../tools/read_profile_view.js";
import searchMemories from "../tools/search_memories.js";
import searchMemoryThreads from "../tools/search_memory_threads.js";
import sendWorkspaceFile from "../tools/send_workspace_file.js";
import sendWorkspaceImage from "../tools/send_workspace_image.js";
import sendWidget from "../tools/send_widget.js";
import { EXTERNAL_SEND_WIDGET_PRESENTATION } from "../telegram-widgets/send-widget-tool.js";
import { TELEGRAM_WIDGETS_ENABLED } from "../telegram-widgets/telegram-widget-availability.js";
import { removeGroupFileTool } from "../workspaces/remove-group-file-tool.js";
import webSearch, { LOCAL_WEB_SEARCH_AVAILABLE } from "../tools/web_search.js";
import { controlledWebFetchTool } from "./controlled-web-fetch.js";
import { EXTERNAL_GROUP_FILE_TOOLS } from "./external-group-file-tools.js";
import { authorizeCurrentExternalGroupCapability } from "./external-group-live-policy.js";
import { resolveExternalGroupPolicyIdentity } from "./external-group-policy.js";
import { scheduledExternalTool } from "./scheduled-external-tool.js";
import {
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
  isExternalGroupToolName,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";
import {
  FAMILY_ONLY_TOOLS,
  PRIVATE_ONLY_TOOLS,
  TRUSTED_MODE_TOOLS,
} from "./trusted-mode-tool-catalog.js";

export {
  FAMILY_ONLY_TOOL_NAMES,
  PRIVATE_ONLY_TOOL_NAMES,
  TRUSTED_MODE_TOOL_NAMES,
} from "./trusted-mode-tool-catalog.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

export type ModeToolSurfaceInput =
  | { environment: "family" | "private"; scheduledRun?: boolean }
  | {
      capabilities: ReadonlySet<ExternalGroupToolName>;
      environment: "external";
      includeApplicationCore?: boolean;
      scheduledHistory?: boolean;
      scheduledRun?: boolean;
    };

const DENIED_TOOL_INPUT = z.record(z.string(), z.unknown());

type DirectExternalToolName = Exclude<
  ExternalGroupToolName,
  `manage_memory.${string}` | `manage_memory_thread.${string}`
>;

const EXTERNAL_IMAGE_PATH_MAX_LENGTH = 512;
const EXTERNAL_MODEL_TEXT_MAX_LENGTH = 4_000;
const EXTERNAL_FILE_CAPTION_MAX_LENGTH = 1_024;

/** Both senders take the same input; the Telegram presentation belongs to the tool, not the model. */
function externalWorkspaceSendInputSchema(pathExample: string) {
  return z
    .object({
      caption: z.string().max(EXTERNAL_FILE_CAPTION_MAX_LENGTH).optional(),
      path: z
        .string()
        .min(1)
        .max(EXTERNAL_IMAGE_PATH_MAX_LENGTH)
        .describe(`Относительный путь внутри group workspace, например ${pathExample}`),
      scope: z.literal("group").describe("Workspace текущей внешней группы"),
    })
    .strict();
}

// Shared executors remain unchanged, while external descriptors expose only their executable group
// contract. This prevents the model from planning calls that external authorization must reject.
const EXTERNAL_DIRECT_TOOL_PRESENTATION: Readonly<
  Partial<Record<DirectExternalToolName, Pick<AnyToolDefinition, "description" | "inputSchema">>>
> = {
  generate_image: EXTERNAL_IMAGE_GENERATION_TOOL_PRESENTATION,
  inspect_workspace_image: {
    description: [
      "Проанализировать изображение текущей внешней группы по ровно одному источнику: attachmentId, telegramMessageId или path.",
      "Для path передавай относительный путь внутри group scope, например photos/image.png, а не /workspace/group/photos/image.png.",
      "Результат содержит analysis, path и scope; анализ не сохраняет Telegram bytes.",
    ].join(" "),
    inputSchema: z
      .object({
        attachmentId: z.uuid().optional(),
        path: z.string().min(1).max(EXTERNAL_IMAGE_PATH_MAX_LENGTH).optional(),
        question: z.string().min(1).max(EXTERNAL_MODEL_TEXT_MAX_LENGTH),
        scope: z.literal("group").describe("Область текущей внешней группы"),
        telegramMessageId: z.string().regex(/^\d+$/u).optional(),
      })
      .strict(),
  },
  import_telegram_attachment: {
    description:
      "Скачать разрешённый UTF-8 файл TXT, Markdown, JSON, CSV, TSV, HTML, XML или YAML из сообщения текущей внешней группы в /workspace/group; после импорта прочитай возвращённый path через read_file.",
    inputSchema: z
      .object({
        attachmentId: z.uuid().describe("Opaque attachmentId из текущего сообщения или истории группы"),
      })
      .strict(),
  },
  list_memories: {
    description:
      "Постранично показать записи долговременной памяти текущей внешней группы. Результат: {items,nextCursor}; если nextCursor не null, передай его без изменений в следующий вызов.",
    inputSchema: z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).default(MEMORY_LIST_DEFAULT_LIMIT),
      scope: z.literal("group").optional(),
    }),
  },
  list_memory_threads: {
    description:
      "Постранично показать нити памяти текущей внешней группы без полной истории. Результат: {items,nextCursor}; threadRef бери только из items, а nextCursor передавай без изменений.",
    inputSchema: z
      .object({
        cursor: z.string().regex(THREAD_REF_PATTERN).optional(),
        limit: z.number().int().min(1).max(THREAD_HISTORY_PAGE_MAX_ENTRIES).default(20),
        scope: z.literal("group").optional(),
        status: z.enum(["active", "completed"]).optional(),
      })
      .strict(),
  },
  remember: {
    description:
      "Сохранить одну устойчивую запись из текущего сообщения или одного проверенного sourceSequence видимой дельты в память текущей внешней группы.",
    inputSchema: externalRememberInputSchema,
  },
  send_workspace_file: {
    description:
      "Отправить существующий файл из group workspace документом в текущий Telegram-чат или тему внешней группы. path всегда относительный внутри group scope, например reports/result.pdf; не передавай /workspace/group. Картинку показывай через send_workspace_image. Результат delivered=true подтверждает отправку; alreadySent=true значит, что эти байты уже ушли на этом ходе; при sideEffectStatus completed или unknown не отправляй повторно.",
    inputSchema: externalWorkspaceSendInputSchema("reports/result.pdf"),
  },
  send_workspace_image: {
    description:
      "Показать фотографией картинку из group workspace в текущем Telegram-чате или теме внешней группы, в том числе только что нарисованную generate_image. path всегда относительный внутри group scope, например generated-images/image.png; не передавай /workspace/group. JPEG, PNG или WebP до 10 МБ, иначе отправляй документом через send_workspace_file. Результат delivered=true подтверждает отправку; alreadySent=true значит, что эти байты уже ушли на этом ходе.",
    inputSchema: externalWorkspaceSendInputSchema("generated-images/image.png"),
  },
  send_widget: EXTERNAL_SEND_WIDGET_PRESENTATION,
};

const EXTERNAL_DIRECT_TOOLS: Readonly<Record<DirectExternalToolName, AnyToolDefinition>> = {
  fetch_telegram_avatars: fetchTelegramAvatars as unknown as AnyToolDefinition,
  generate_image: generateImage as unknown as AnyToolDefinition,
  import_telegram_attachment: importTelegramAttachment as unknown as AnyToolDefinition,
  inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition,
  list_group_history: listGroupHistory as unknown as AnyToolDefinition,
  list_memories: listMemories as unknown as AnyToolDefinition,
  list_memory_threads: listMemoryThreads as unknown as AnyToolDefinition,
  manage_memory_conflict: manageMemoryConflict as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  read_memory_thread: readMemoryThread as unknown as AnyToolDefinition,
  remove_group_file: removeGroupFileTool as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  search_memory_threads: searchMemoryThreads as unknown as AnyToolDefinition,
  send_workspace_file: sendWorkspaceFile as unknown as AnyToolDefinition,
  send_workspace_image: sendWorkspaceImage as unknown as AnyToolDefinition,
  send_widget: sendWidget as unknown as AnyToolDefinition,
  web_fetch: controlledWebFetchTool as unknown as AnyToolDefinition,
  web_search: webSearch as unknown as AnyToolDefinition,
};

function groupToolForbidden(): AppError {
  return new AppError(
    "AGENT_GROUP_TOOL_FORBIDDEN",
    "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
  );
}

// Any one of these grants authorizes the capability. Drawing into a workspace nobody can see is not
// a capability, so the grant to generate images carries the sender that shows the result.
const GRANTED_BY: Readonly<
  Partial<Record<ExternalGroupToolName, readonly ExternalGroupToolName[]>>
> = {
  send_workspace_image: ["send_workspace_image", "generate_image"],
};

// A capability that only serves another one is authorized together with it, in one read of the
// policy: the avatars of a group whose drawing grant was revoked after the descriptor was built
// must not be fetched.
const REQUIRES_ALSO: Readonly<
  Partial<Record<ExternalGroupToolName, readonly ExternalGroupToolName[]>>
> = {
  fetch_telegram_avatars: ["generate_image"],
};

async function withExternalGroupCapability<T>(
  ctx: ToolContext,
  capability: ExternalGroupToolName,
  operation: () => Promise<T>,
): Promise<T> {
  const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
  if (!identity) throw groupToolForbidden();

  // Scheduled file delivery is an owner-approved side effect, so revalidate the exact root run.
  const scheduledDelivery = scheduledDeliveryMetadata(ctx);
  if (capability === "send_workspace_file" && scheduledDelivery) {
    await authorizeAgentScheduleDelivery({
      applicationSessionId: scheduledDelivery.applicationSessionId,
      eveSessionId: ctx.session.id,
      familyId: scheduledDelivery.familyId,
      groupId: scheduledDelivery.groupId,
      messageThreadId: scheduledDelivery.messageThreadId,
      ownerUserId: scheduledDelivery.ownerUserId,
      runId: scheduledDelivery.runId,
      scope: scheduledDelivery.scope,
      telegramChatId: scheduledDelivery.telegramChatId,
    });
  }

  // Committing this final live check is the operation's authorization linearization point. The DB
  // connection is released before repositories run so concurrent tools cannot exhaust the pool by
  // each holding an outer connection while waiting for an inner repository connection.
  const alsoRequired = REQUIRES_ALSO[capability];
  if (alsoRequired === undefined) {
    await authorizeCurrentExternalGroupCapability(identity, GRANTED_BY[capability] ?? capability);
  } else {
    await authorizeCurrentExternalGroupCapability(identity, GRANTED_BY[capability] ?? capability, { alsoRequired });
  }
  return await operation();
}

function deniedTool(toolName: string): AnyToolDefinition {
  return defineTool({
    description: `Инструмент ${toolName} недоступен в текущей внешней группе.`,
    inputSchema: DENIED_TOOL_INPUT,
    async execute() {
      throw groupToolForbidden();
    },
  }) as unknown as AnyToolDefinition;
}

function allowedDirectTool(capability: DirectExternalToolName, definition: AnyToolDefinition): AnyToolDefinition {
  return defineTool({
    ...definition,
    ...EXTERNAL_DIRECT_TOOL_PRESENTATION[capability],
    async execute(input, ctx) {
      return await withExternalGroupCapability(ctx, capability, async () => await definition.execute(input, ctx));
    },
  });
}

function allowedMemoryTool(actions: readonly ManageMemoryAction[]): AnyToolDefinition {
  const definition = manageMemory as unknown as AnyToolDefinition;
  return defineTool({
    ...definition,
    ...manageMemoryPresentation(actions),
    async execute(input, ctx) {
      const action = (input as { action?: unknown }).action;
      if (action !== "edit" && action !== "delete" && action !== "undo") {
        throw new AppError(
          "AGENT_GROUP_TOOL_INPUT_INVALID",
          "Не удалось определить операцию с памятью. Повторите запрос",
        );
      }
      return await withExternalGroupCapability(
        ctx,
        `manage_memory.${action}`,
        async () => await definition.execute(input, ctx),
      );
    },
  });
}

function allowedMemoryThreadTool(): AnyToolDefinition {
  const definition = manageMemoryThread as unknown as AnyToolDefinition;
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      const action = (input as { action?: unknown }).action;
      if (action !== "complete" && action !== "reactivate") {
        throw new AppError(
          "AGENT_GROUP_TOOL_INPUT_INVALID",
          "Не удалось определить операцию с нитью памяти. Повторите запрос",
        );
      }
      return await withExternalGroupCapability(
        ctx,
        `manage_memory_thread.${action}`,
        async () => await definition.execute(input, ctx),
      );
    },
  });
}

function buildExternalToolSurface(
  allowed: ReadonlySet<ExternalGroupToolName>,
  includeApplicationCore: boolean,
  scheduledHistory: boolean,
  scheduledRun: boolean,
): ToolMap {
  const imageGenerationAllowed = IMAGE_GENERATION_AVAILABLE &&
    !scheduledRun && allowed.has("generate_image");
  const surface: Record<string, AnyToolDefinition> = {
    ...EXTERNAL_GROUP_FILE_TOOLS,
    // The wrapper is fail-closed per skill name (imagegen, analyst skills, granted authored
    // skills are each re-authorized live), so the descriptor itself grants nothing. Gating it on
    // generate_image alone left the analyst skills unreachable without an image grant.
    load_skill: scheduledRun ? deniedTool("load_skill") : externalGroupLoadSkillTool,
  };
  if (includeApplicationCore) {
    surface.read_profile_view = readProfileView as unknown as AnyToolDefinition;
    if (!scheduledRun) {
      surface.manage_behavior_preference = manageBehaviorPreference as unknown as AnyToolDefinition;
    }
    if (scheduledHistory) {
      surface.read_scheduled_group_history = readScheduledGroupHistory as unknown as AnyToolDefinition;
    }
  }
  // Granted application capabilities are re-checked at execution against the live policy.
  for (const capability of allowed) {
    // A scheduled prompt has no current user message that can back a new memory claim.
    if (scheduledRun && capability === "remember") continue;
    if (capability === "web_search" && (scheduledRun || !LOCAL_WEB_SEARCH_AVAILABLE)) continue;
    // Billable image generation requires a current interactive request, never a background run;
    // the avatars exist only for it.
    if ((capability === "generate_image" || capability === "fetch_telegram_avatars") && !imageGenerationAllowed) continue;
    // A card is a reply to people in the chat, never a scheduled post; the switch removes it everywhere.
    if (capability === "send_widget" && (scheduledRun || !TELEGRAM_WIDGETS_ENABLED)) continue;
    // A granted image sender still needs its live check, which `GRANTED_BY` resolves.
    if (capability.startsWith("manage_memory.")) continue;
    if (capability.startsWith("manage_memory_thread.")) continue;
    if (!isExternalGroupToolName(capability)) continue;
    const definition = EXTERNAL_DIRECT_TOOLS[capability as DirectExternalToolName];
    if (definition === undefined) continue;
    surface[capability] = allowedDirectTool(capability as DirectExternalToolName, definition);
  }
  // generate_image now only saves into the workspace, so a chat allowed to draw must be able to
  // show the result even when the owner granted nothing else.
  if (imageGenerationAllowed && surface.send_workspace_image === undefined) {
    surface.send_workspace_image = allowedDirectTool(
      "send_workspace_image",
      EXTERNAL_DIRECT_TOOLS.send_workspace_image,
    );
  }
  const memoryActions = MANAGE_MEMORY_ACTIONS.filter((action) => allowed.has(`manage_memory.${action}`));
  if (memoryActions.length > 0) {
    surface.manage_memory = allowedMemoryTool(memoryActions);
  }
  if ([...allowed].some((capability) => capability.startsWith("manage_memory_thread."))) {
    surface.manage_memory_thread = allowedMemoryThreadTool();
  }

  // Eve always registers its own built-ins, and 0.40.0 cannot hide a framework descriptor, so the
  // ones an external group must never reach stay overridden with an explicit denial.
  for (const toolName of FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS) {
    if (toolName === "web_fetch" || toolName === "web_search") {
      // Granted local web_search and web_fetch keep their execution-time policy wrappers.
      // Other providers retain Eve's native search descriptor, with revocation at the next step.
      if (!allowed.has(toolName) || scheduledRun && toolName === "web_search") {
        surface[toolName] = deniedTool(toolName);
      }
      continue;
    }
    surface[toolName] = deniedTool(toolName);
  }
  const effectiveSurface = scheduledRun
    ? Object.fromEntries(Object.entries(surface).map(([name, definition]) => [name, scheduledExternalTool(definition)]))
    : surface;
  return wrapModelFacingToolMap(effectiveSurface);
}

function allowlistKey(allowed: ReadonlySet<ExternalGroupToolName>): string {
  return [...allowed].sort().join("\0");
}

const TRUSTED_APPLICATION_SURFACES: Readonly<Record<"family" | "private", ToolMap>> = {
  family: wrapModelFacingToolMap({
    ...TRUSTED_MODE_TOOLS,
    ...FAMILY_ONLY_TOOLS,
  }),
  private: wrapModelFacingToolMap({
    ...TRUSTED_MODE_TOOLS,
    ...PRIVATE_ONLY_TOOLS,
  }),
};

// An interactive turn also receives, with each tool result, the messages its author sent meanwhile.
const TRUSTED_SURFACES: Readonly<Record<"family" | "private", ToolMap>> = {
  family: withTurnInterjectionSurface(TRUSTED_APPLICATION_SURFACES.family),
  private: withTurnInterjectionSurface(TRUSTED_APPLICATION_SURFACES.private),
};

const TRUSTED_SCHEDULED_SURFACES: Readonly<Record<"family" | "private", ToolMap>> = Object.fromEntries(
  Object.entries(TRUSTED_APPLICATION_SURFACES).map(([environment, surface]) => {
    // A scheduled turn can read chat instructions but has no user source for prompt or memory writes.
    const {
      manage_behavior_preference: _manageBehaviorPreference,
      manage_skill: _manageSkill,
      manage_duty_schedule: _manageDutySchedule,
      configure_duty_sheet_source: _configureDutySheetSource,
      inspect_duty_sheet_source: _inspectDutySheetSource,
      remember: _remember,
      ...readOnlyPromptSurface
    } = surface;
    return [environment, readOnlyPromptSurface];
  }),
) as Record<"family" | "private", ToolMap>;

const EXTERNAL_SURFACES = new Map<string, ToolMap>();

export function buildModeToolSurface(input: ModeToolSurfaceInput): ToolMap {
  if (input.environment !== "external") {
    return input.scheduledRun === true
      ? TRUSTED_SCHEDULED_SURFACES[input.environment]
      : TRUSTED_SURFACES[input.environment];
  }

  // A malformed allowlist value means the trusted snapshot is corrupt, so deny every capability.
  const allowed = [...input.capabilities].some((name) => !isExternalGroupToolName(name))
    ? new Set<ExternalGroupToolName>()
    : input.capabilities;
  const includeApplicationCore = input.includeApplicationCore !== false;
  const scheduledHistory = input.scheduledHistory === true;
  const scheduledRun = input.scheduledRun === true || scheduledHistory;
  const key = [
    includeApplicationCore ? "core" : "failed",
    scheduledHistory ? "history" : "ordinary",
    scheduledRun ? "scheduled" : "interactive",
    allowlistKey(allowed),
  ].join("|");
  const cached = EXTERNAL_SURFACES.get(key);
  if (cached) return cached;
  const surface = buildExternalToolSurface(allowed, includeApplicationCore, scheduledHistory, scheduledRun);
  EXTERNAL_SURFACES.set(key, surface);
  return surface;
}

export function buildSubagentToolSurface(input: ModeToolSurfaceInput): ToolMap {
  const effectiveInput = input.environment === "external"
    ? {
      ...input,
      capabilities: new Set([...input.capabilities].filter((name) => name !== "generate_image" && name !== "fetch_telegram_avatars")),
    }
    : input;
  const {
    fetch_telegram_avatars: _fetchTelegramAvatars,
    generate_image: _generateImage,
    manage_behavior_preference: _manageBehaviorPreference,
    manage_skill: _manageSkill,
    manage_duty_schedule: _manageDutySchedule,
    configure_duty_sheet_source: _configureDutySheetSource,
    inspect_duty_sheet_source: _inspectDutySheetSource,
    remember: _remember,
    // A child works on a fresh context and reports to the root; cards in the chat are the root's.
    send_widget: _sendWidget,
    ...surface
  } = buildModeToolSurface(effectiveInput);
  // A child never loads external skills: imagegen rides on the removed grant and authored skills
  // belong to the root turn that the owner's grant addressed.
  return input.environment === "external"
    ? { ...surface, load_skill: deniedTool("load_skill") }
    : surface;
}
