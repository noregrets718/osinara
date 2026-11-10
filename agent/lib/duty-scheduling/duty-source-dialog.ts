/** Preview a standard source; save only an exactly approved, unchanged and revalidated read. No Google writes. */
import { randomUUID } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { AppError } from "../app-error.js";
import { flattenDisplayText } from "../display-text.js";
import { applicationSessionId } from "../sessions/session-context.js";
import { requireInteractiveDutyOwner } from "./duty-owner-context.js";
import { createDutySheetSource, dutySheetSections } from "./duty-sheet-format.js";
import { readDutySheet } from "./duty-sheet-reader.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository } from "./duty-sheet-source-repository.js";
import { dutyOwnerApprovalProof, requireDutyApproval, withDutyOwner } from "./duty-storage.js";
import { parseDutySourceConfirmation, parseDutySourceDialog } from "./duty-source-dialog-input.js";

export function createDutySourceDialog(deps: { read: typeof readDutySheet; sources: typeof dutySheetSourceRepository }) {
  return {
    async inspect(raw: unknown, ctx: ToolContext) {
      const input = parseDutySourceDialog(raw);
      const auth = requireInteractiveDutyOwner(ctx);
      ctx.abortSignal.throwIfAborted();
      const state = await deps.sources.inspect(auth, input.groupId);
      if (input.action === "get") return { ...state, configured: state.configuration !== null, configurationSaved: false as const };
      const source = createDutySheetSource(input.spreadsheetId, input.profileRef);
      const loaded = await deps.read(source, ctx);
      ctx.abortSignal.throwIfAborted();
      const after = await deps.sources.inspect(auth, input.groupId);
      if (after.configuration?.id !== state.configuration?.id) throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Источник изменился во время предпросмотра. Повторите просмотр");
      const confirmationInput = { operationId: randomUUID(), groupId: input.groupId, expectedVersion: state.configuration?.version ?? 0, source, readHash: loaded.source.contentHash };
      return { group: state.group, current: state.configuration, confirmationInput, counts: loaded.counts,
        timezone: loaded.data.timezone, rulesVersion: loaded.data.rules.version, historyMode: loaded.history.mode,
        previewText: [
          `Источник для группы «${flattenDisplayText(state.group.title)}»: https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit`,
          `Текущая версия настройки: ${confirmationInput.expectedVersion}. После подтверждения: ${confirmationInput.expectedVersion + 1}.`,
          `Листов: ${dutySheetSections.length}; жильцов: ${loaded.counts.residents}; объектов: ${loaded.counts.objects}; смен: ${loaded.counts.workShifts}; прошлых графиков: ${loaded.counts.schedules}.`,
          `Часовой пояс: ${loaded.data.timezone}; версия правил: ${flattenDisplayText(loaded.data.rules.version)}; режим истории: ${loaded.history.mode}.`,
          ...(loaded.history.mode === "not_loaded" ? ["История ещё не загружена: подготовка графика будет заблокирована до явного выбора режима учёта."] : []),
          "Будет сохранена настройка источника для новых графиков. Существующие снимки сохранятся. Ячейки таблицы и сообщения группы не изменяются.",
        ].join("\n"), configurationSaved: false as const };
    },
    async configure(raw: unknown, ctx: ToolContext) {
      const input = parseDutySourceConfirmation(raw);
      const auth = requireInteractiveDutyOwner(ctx);
      ctx.abortSignal.throwIfAborted();
      const evidence = { applicationSessionId: applicationSessionId(ctx), eveSessionId: ctx.session.id, toolCallId: ctx.callId };
      // Even direct execute calls need the exact consumed personal receipt before Google is read.
      await withDutyOwner(auth, (client) => requireDutyApproval(client, auth, dutyOwnerApprovalProof(auth, raw, evidence, DUTY_SOURCE_TOOL)));
      const previous = await deps.sources.findOperation(auth, input);
      if (previous) return { configuration: previous, configurationSaved: true as const, reused: true };
      const state = await deps.sources.inspect(auth, input.groupId);
      if ((state.configuration?.version ?? 0) !== input.expectedVersion) throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Настройка изменилась. Сделайте новый предпросмотр и подтвердите его");
      const loaded = await deps.read(input.source, ctx);
      ctx.abortSignal.throwIfAborted();
      if (loaded.source.contentHash !== input.readHash) throw new AppError("AGENT_DUTY_SOURCE_READ_CHANGED", "Таблица изменилась после предпросмотра. Просмотрите данные и подтвердите заново");
      const configuration = await deps.sources.save(auth, input, evidence);
      return { configuration, configurationSaved: true as const, reused: false };
    },
  };
}
export const dutySourceDialog = createDutySourceDialog({ read: readDutySheet, sources: dutySheetSourceRepository });
