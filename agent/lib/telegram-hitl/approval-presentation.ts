/**
 * Semantic Telegram presentation for HITL requests.
 *
 * Exports:
 * - `TelegramApprovalPresenter`: asynchronous trusted approval presentation contract.
 * - `createTelegramApprovalPresenter`: injectable presenter with schedule subject resolution.
 * - `presentTelegramApproval`: production presenter backed by PostgreSQL repositories.
 */
import type { SessionContext } from "eve/context";

import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import type {
  AgentScheduleRecord,
  AgentScheduleRecurrence,
} from "../agent-schedules/agent-schedule-record.js";
import { describeRecurrence } from "../agent-schedules/agent-schedule-recurrence.js";
import {
  type AgentScheduleAuthorization,
  requireAgentScheduleAuthorization,
} from "../agent-schedules/agent-schedule-context.js";
import { AppError } from "../app-error.js";
import { loadDutySourceApproval } from "../duty-scheduling/duty-source-approval.js";
import { loadDutyEditApproval } from "../duty-scheduling/duty-edit-approval.js";
import { loadDutyReviewApproval } from "../duty-scheduling/duty-review-approval.js";
import { dutyApprovalDialog } from "../duty-scheduling/duty-approval-dialog.js";
import { clipText, flattenDisplayText } from "../display-text.js";
import type { BrowserConfirmApprovalSubject } from "../browser/browser-tools-production.js";
import { loadBrowserConfirmApproval } from "../browser/browser-tools-production.js";
import { loadLavkaDeliveryPoint } from "../lavka/lavka-production.js";
import { yandexTaxiApprovalPrompt } from "../yandex-taxi/yandex-taxi-approval.js";
import type { GmailMessageApprovalSubject } from "../google-workspace/gmail-message-approval.js";
import { loadGmailMessageApproval } from "../google-workspace/gmail-message-approval.js";
import { requireGmailMessageInput } from "../google-workspace/gmail-message-contract.js";
import {
  localizeTelegramInputRequest,
  type TelegramInputRequest,
} from "../telegram-interface.js";
import {
  BROWSER_CONFIRM_CONSEQUENCE,
  GOOGLE_WORKSPACE_CONSEQUENCE,
  SCHEDULE_CONSEQUENCES,
} from "./approval-consequences.js";
import {
  approvalFact,
  buildApprovalMessage,
  googleWorkspaceFacts,
  sanitizeApprovalLine,
} from "./approval-message.js";

interface ApprovalPresentationDependencies {
  findDutyScheduleApproval?(input: unknown, ctx: Pick<SessionContext, "session">): Promise<string>;
  findDutyReview?(input: unknown, ctx: Pick<SessionContext, "session">): Promise<{ prompt: string; approveLabel: string }>;
  findDutyEdits?(input: unknown, ctx: Pick<SessionContext, "session">): Promise<string>;
  findDutySource?(input: unknown, ctx: Pick<SessionContext, "session">): Promise<string>;
  findBrowserConfirm(input: { epoch: string; n: number }, ctx: Pick<SessionContext, "session">): Promise<BrowserConfirmApprovalSubject>;
  /** The label of the requester's Lavka delivery point, or null when none is chosen. */
  findLavkaDeliveryPoint?(ctx: Pick<SessionContext, "session">): Promise<{ key: string; label: string } | null>;
  findGmailMessage(
    messageId: string,
    profileRef: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<GmailMessageApprovalSubject>;
  findSchedule(auth: AgentScheduleAuthorization, id: string): Promise<AgentScheduleRecord | null>;
}

export type TelegramApprovalPresenter = (
  request: TelegramInputRequest,
  ctx: Pick<SessionContext, "session">,
) => Promise<TelegramInputRequest>;

const SCHEDULE_ACTIONS: Readonly<Record<string, { action: string }>> = {
  create: {
    action: "Создать агентное расписание",
      },
  delete: {
    action: "Удалить агентное расписание",
      },
  pause: {
    action: "Приостановить агентное расписание",
      },
  resume: {
    action: "Возобновить агентное расписание",
      },
  run_now: {
    action: "Запустить агентное расписание сейчас",
      },
  update: {
    action: "Изменить агентное расписание",
      },
};

const GMAIL_MESSAGE_ACTIONS = {
  delete: {
    action: "Безвозвратно удалить письмо Gmail",
    consequence: "Письмо будет удалено навсегда. Его нельзя будет восстановить.",
  },
  mark_read: {
    action: "Отметить письмо Gmail прочитанным",
    consequence: "Письмо больше не будет отмечено как непрочитанное.",
  },
  mark_unread: {
    action: "Отметить письмо Gmail непрочитанным",
    consequence: "Письмо будет отмечено как непрочитанное.",
  },
  restore: {
    action: "Восстановить письмо Gmail из корзины",
    consequence: "Письмо будет возвращено из корзины.",
  },
  trash: {
    action: "Переместить письмо в корзину Gmail",
    consequence: "Письмо будет перемещено в корзину. Его можно будет восстановить.",
  },
} as const;

function approvalValue(value: string | null, missing: string, maxCharacters = 500): string {
  if (value === null) return missing;
  const normalized = flattenDisplayText(value);
  if (!normalized) return missing;
  return clipText(normalized, maxCharacters);
}

function gmailMessagePrompt(
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
  message: GmailMessageApprovalSubject,
): string {
  const action = GMAIL_MESSAGE_ACTIONS[actionName];
  return [
    "Подтверждение действия",
    "",
    `Действие: ${action.action}`,
    `Профиль: ${message.scope === "personal" ? "личный" : "семейный"}`,
    `Почтовый ящик: ${approvalValue(message.profileDisplayName, "не определён")}`,
    `Отправитель: ${approvalValue(message.from, "не указан")}`,
    `Тема: ${approvalValue(message.subject, "без темы")}`,
    `Дата: ${approvalValue(message.date, "не указана")}`,
    `Фрагмент письма: ${approvalValue(message.snippet, "не предоставлен Gmail", 240)}`,
    `Gmail ID: ${message.id}`,
    "",
    `Что произойдёт: ${action.consequence}`,
  ].join("\n");
}

function gmailMessageOptions(
  request: TelegramInputRequest,
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
): TelegramInputRequest["options"] {
  const approveLabels: Readonly<Record<keyof typeof GMAIL_MESSAGE_ACTIONS, string>> = {
    delete: "Удалить навсегда",
    mark_read: "Отметить прочитанным",
    mark_unread: "Отметить непрочитанным",
    restore: "Восстановить письмо",
    trash: "Переместить в корзину",
  };
  return request.options?.map((option) => ({
    ...option,
    label: option.id === "approve"
      ? approveLabels[actionName]
      : option.id === "deny" || option.id === "cancel"
        ? "Отменить"
        : option.label,
  }));
}

function scheduleDate(schedule: AgentScheduleRecord): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: schedule.timezone,
  }).format(new Date(schedule.nextRunAt));
}

function requestedRecurrence(value: unknown): AgentScheduleRecurrence {
  // Presentation accepts only the recurrence shapes it can explain unambiguously to the user.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось показать новую периодичность агентного расписания",
    );
  }
  const recurrence = value as Record<string, unknown>;
  if (recurrence.kind === "once") return { kind: "once" };
  if (recurrence.kind === "daily" && typeof recurrence.interval === "number") {
    return { interval: recurrence.interval, kind: "daily" };
  }
  if (
    recurrence.kind === "weekly" &&
    typeof recurrence.interval === "number" &&
    Array.isArray(recurrence.daysOfWeek) &&
    recurrence.daysOfWeek.every((day) => typeof day === "number")
  ) {
    return {
      daysOfWeek: recurrence.daysOfWeek as number[],
      interval: recurrence.interval,
      kind: "weekly",
    };
  }
  throw new AppError(
    "AGENT_APPROVAL_INPUT_INVALID",
    "Не удалось показать новую периодичность агентного расписания",
  );
}

function scheduleChanges(input: Record<string, unknown>): string[] {
  // Show only fields that the approved update will replace; the technical schedule ID is excluded.
  const changes: string[] = [];
  if (typeof input.title === "string") changes.push(`Название: ${input.title}`);
  if (typeof input.userRequest === "string") changes.push(`Назначение: ${input.userRequest}`);
  if (input.recurrence !== undefined) {
    changes.push(`Периодичность: ${describeRecurrence(requestedRecurrence(input.recurrence))}`);
  }
  if (typeof input.nextRunAt === "string") changes.push(`Следующий запуск: ${input.nextRunAt}`);
  if (typeof input.scenarioPrompt === "string") {
    changes.push(`Сценарий: ${input.scenarioPrompt}`);
  }
  if (changes.length === 0) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось определить изменения агентного расписания",
    );
  }
  return changes;
}

function schedulePrompt(
  actionName: string,
  schedule: AgentScheduleRecord,
  changes: readonly string[],
): string {
  // Одна и та же структура во всех окнах: заголовок, факты, последствие. Значения расписания
  // проходят ту же очистку, что и остальные факты, поэтому перенос строки в названии или сценарии
  // не может дорисовать строку, выглядящую как строка приложения.
  return buildApprovalMessage({
    actionLabel: lowerFirst(SCHEDULE_ACTIONS[actionName]!.action),
    consequence: SCHEDULE_CONSEQUENCES[actionName]!,
    facts: [
      ...approvalFact("Расписание", schedule.title),
      ...approvalFact("Назначение", schedule.userRequest),
      ...approvalFact("Периодичность", describeRecurrence(schedule.recurrence)),
      ...approvalFact("Следующий запуск", `${scheduleDate(schedule)} (${schedule.timezone})`),
      ...approvalFact("Сценарий", schedule.scenarioPrompt),
    ],
    // Отдельным блоком: предлагаемые значения обязаны быть визуально отделены от текущих, иначе
    // две строки «Сценарий:» — сохранённая и новая — читаются как одна.
    // `scheduleChanges` уже формирует строки «Метка: значение», поэтому им нужна только очистка.
    ...(changes.length === 0
      ? {}
      : { section: { lines: changes.map(sanitizeApprovalLine), title: "Изменения:" } }),
  });
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}


export function createTelegramApprovalPresenter(
  dependencies: ApprovalPresentationDependencies,
): TelegramApprovalPresenter {
  return async (request, ctx) => {
    const localized = localizeTelegramInputRequest(request);
    if (request.display === "confirmation" && request.action.toolName === "approve_duty_schedule") {
      if (!dependencies.findDutyScheduleApproval) throw new AppError("AGENT_APPROVAL_SUBJECT_INVALID", "Не удалось показать утверждаемый график");
      return { ...localized, prompt: await dependencies.findDutyScheduleApproval(request.action.input, ctx),
        options: localized.options?.map((option) => ({ ...option, label: option.id === "approve" ? "Утвердить показанную версию" : option.label })) };
    }
    if (request.display === "confirmation" && request.action.toolName === "resolve_duty_sheet_write") {
      if (!dependencies.findDutyReview) throw new AppError("AGENT_APPROVAL_SUBJECT_INVALID", "Не удалось показать решение по сверке");
      const subject = await dependencies.findDutyReview(request.action.input, ctx);
      return { ...localized, prompt: subject.prompt,
        options: localized.options?.map((option) => ({ ...option, label: option.id === "approve" ? subject.approveLabel : option.label })) };
    }
    if (request.display === "confirmation" && request.action.toolName === "apply_duty_sheet_changes") {
      if (!dependencies.findDutyEdits) throw new AppError("AGENT_APPROVAL_SUBJECT_INVALID", "Не удалось показать подтверждаемые правки");
      return { ...localized, prompt: await dependencies.findDutyEdits(request.action.input, ctx),
        options: localized.options?.map((option) => ({ ...option, label: option.id === "approve" ? "Записать правки" : option.label })) };
    }
    if (request.display === "confirmation" && request.action.toolName === "configure_duty_sheet_source") {
      if (!dependencies.findDutySource) throw new AppError("AGENT_APPROVAL_SUBJECT_INVALID", "Не удалось показать настройку источника");
      return { ...localized, prompt: await dependencies.findDutySource(request.action.input, ctx),
        options: localized.options?.map((option) => ({ ...option, label: option.id === "approve" ? "Сохранить источник" : option.label })) };
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "manage_gmail_message"
    ) {
      const input = requireGmailMessageInput(request.action.input);
      const message = await dependencies.findGmailMessage(input.messageId, input.profileRef, ctx);
      return {
        ...localized,
        options: gmailMessageOptions(localized, input.action),
        prompt: gmailMessagePrompt(input.action, message),
      };
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "browser_confirm"
    ) {
      const { epoch, n } = request.action.input;
      if (typeof epoch !== "string" || !epoch || typeof n !== "number") {
        throw new AppError("AGENT_APPROVAL_SUBJECT_INVALID", "Не удалось определить шаг в браузере для подтверждения");
      }
      const subject = await dependencies.findBrowserConfirm({ epoch, n }, ctx);
      return {
        ...localized,
        prompt: buildApprovalMessage({
          actionLabel: `нажать «${subject.button}» на ${subject.site}`,
          consequence: BROWSER_CONFIRM_CONSEQUENCE,
          facts: [
            ...approvalFact("Сайт", subject.site),
            ...approvalFact("Кнопка", subject.button),
            ...approvalFact("Страница", subject.url),
            ...approvalFact("Введено в форму", subject.entered.length > 0 ? subject.entered.join(", ") : "ничего"),
          ],
        }),
      };
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "yandex_lavka"
    ) {
      const input = request.action.input as { action?: unknown; addressKey?: unknown; cartVersion?: unknown; orderId?: unknown; total?: unknown };
      if (input.action === "cancel") {
        return {
          ...localized,
          prompt: buildApprovalMessage({
            actionLabel: "отменить заказ в Яндекс Лавке",
            consequence: "Заказ будет отменён в аккаунте Лавки. Деньги вернёт Лавка по своим правилам.",
            facts: approvalFact("Заказ", typeof input.orderId === "string" ? input.orderId : null),
          }),
        };
      }
      if (input.action !== "order" || typeof input.total !== "number" || typeof input.cartVersion !== "number" || typeof input.addressKey !== "string") {
        throw new AppError("AGENT_APPROVAL_SUBJECT_INVALID", "Не удалось определить заказ в Лавке для подтверждения");
      }
      const point = dependencies.findLavkaDeliveryPoint ? await dependencies.findLavkaDeliveryPoint(ctx) : null;
      // The window shows only the address the order will carry: another one means a stale preview.
      if (point !== null && point.key !== input.addressKey) {
        throw new AppError("AGENT_LAVKA_ADDRESS_CHANGED", "Адрес доставки изменился после предпросмотра. Сделайте новый preview");
      }
      const address = point?.label ?? null;
      return {
        ...localized,
        prompt: buildApprovalMessage({
          actionLabel: `оформить заказ в Яндекс Лавке на ${input.total} ₽`,
          consequence: "Лавка спишет эту сумму с карты аккаунта и начнёт сборку. Если сумма или корзина изменились после предпросмотра, заказ не уйдёт.",
          facts: [
            ...approvalFact("Сумма", `${input.total} ₽`),
            ...approvalFact("Адрес", address ?? "не выбран"),
            ...approvalFact("Версия корзины", String(input.cartVersion)),
          ],
        }),
      };
    }
    if (request.display === "confirmation" && request.action.toolName === "yandex_taxi") {
      return { ...localized, prompt: yandexTaxiApprovalPrompt(request.action.input) };
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "execute_google_workspace"
    ) {
      return {
        ...localized,
        prompt: buildApprovalMessage({
          actionLabel: "изменение в Google Workspace",
          consequence: GOOGLE_WORKSPACE_CONSEQUENCE,
          facts: googleWorkspaceFacts(request.action.input),
        }),
      };
    }
    if (
      request.display !== "confirmation" ||
      request.action.toolName !== "manage_agent_schedule"
    ) return localized;

    const actionName = request.action.input.action;
    if (typeof actionName !== "string" || !SCHEDULE_ACTIONS[actionName]) {
      throw new AppError(
        "AGENT_APPROVAL_ACTION_INVALID",
        "Не удалось определить действие с агентным расписанием",
      );
    }
    if (actionName === "create") return localized;

    const id = request.action.input.id;
    if (typeof id !== "string" || !id) {
      throw new AppError(
        "AGENT_APPROVAL_SUBJECT_INVALID",
        "Не удалось определить агентное расписание для подтверждения",
      );
    }
    const schedule = await dependencies.findSchedule(requireAgentScheduleAuthorization(ctx), id);
    if (!schedule) {
      throw new AppError(
        "AGENT_APPROVAL_SUBJECT_NOT_FOUND",
        "Агентное расписание для подтверждения не найдено или больше недоступно",
      );
    }
    const changes = actionName === "update" ? scheduleChanges(request.action.input) : [];
    return {
      ...localized,
      prompt: schedulePrompt(actionName, schedule, changes),
    };
  };
}

export const presentTelegramApproval = createTelegramApprovalPresenter({
  findDutyScheduleApproval: dutyApprovalDialog.present,
  findDutyReview: loadDutyReviewApproval,
  findDutyEdits: loadDutyEditApproval,
  findDutySource: loadDutySourceApproval,
  findBrowserConfirm: loadBrowserConfirmApproval,
  findLavkaDeliveryPoint: loadLavkaDeliveryPoint,
  findGmailMessage: loadGmailMessageApproval,
  findSchedule: (auth, id) => agentScheduleRepository.findById(auth, id),
});
