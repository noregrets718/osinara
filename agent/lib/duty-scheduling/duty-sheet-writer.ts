/** One approved attempt: re-read, validate, persist dispatch, write once, verify. Never retries effects. */
import type { ToolContext } from "eve/tools";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { executeGoogleWorkspace } from "../google-workspace/google-workspace-executor.js";
import { dutySheetDataHash, parseDutySheetWrite, planDutySheetWrite } from "./duty-sheet-change.js";
import { readDutySheet } from "./duty-sheet-reader.js";
import { dutyApprovalEvidenceSchema, type DutyApprovalEvidence } from "./duty-snapshot.js";
import { dutySheetWriteLog } from "./duty-sheet-write-log.js";
import { withDutyOwner } from "./duty-storage.js";
import { dutySheetWorkerContext, withDutySheetWorker } from "./duty-sheet-worker.js";

interface Dependencies {
  owner: typeof requirePrivateTelegramOwner; read: typeof readDutySheet; execute: typeof executeGoogleWorkspace;
  log: typeof dutySheetWriteLog; withOwner: typeof withDutyOwner;
  withWorker?: typeof withDutySheetWorker;
}

export function createDutySheetWriter(dependencies: Dependencies) {
  return async (raw: unknown, evidence: DutyApprovalEvidence, ctx: ToolContext) => {
    const auth = dependencies.owner(ctx);
    const input = parseDutySheetWrite(raw);
    const approvedRaw = structuredClone(raw);
    const approvedEvidence = dutyApprovalEvidenceSchema.parse(evidence);
    return (dependencies.withWorker ?? withDutySheetWorker)(input.operationId, async (worker) => {
      const claim = await dependencies.log.claim(auth, input, approvedRaw, approvedEvidence);
      if (!claim.claimed) return claim.result;
      const activeContext = dutySheetWorkerContext(ctx, worker);
      let dispatched = false;
      let recordedSuccess = false;
      try {
        const current = await dependencies.read(input.source, activeContext, undefined, { formulas: true });
        const plan = planDutySheetWrite(input, current.response);
        await worker.check();
        await dependencies.log.start(auth, input, approvedRaw, approvedEvidence, plan);
        dispatched = true; // Durable 'writing' is committed before calling the provider, including crashes here.
        await worker.check();
        const result = await dependencies.execute({ argv: plan.argv, expectedProfileRef: input.source.profileRef }, activeContext);
        if (result.kind !== "mutation" || !result.completed || result.profileRef !== input.source.profileRef || result.scope !== "personal") {
          throw new AppError("AGENT_DUTY_SHEET_WRITE_UNVERIFIED", "Ответ записи не подтверждает выбранную таблицу и профиль");
        }
        const observed = await dependencies.read(input.source, activeContext, undefined, { formulas: true });
        await worker.check();
        if (dutySheetDataHash(observed) !== plan.expectedDataHash) throw new AppError("AGENT_DUTY_SHEET_WRITE_UNVERIFIED", "Результат таблицы отличается от подтверждённого изменения");
        const saved = await dependencies.log.finish(input.operationId, "applied");
        recordedSuccess = true;
        // A role revoked during the request must not receive the resulting cell data.
        return await dependencies.withOwner(auth, async () => saved);
      } catch (error) {
        // A committed success is not rewritten if the final access check fails.
        if (recordedSuccess) throw error;
        const code = error instanceof AppError ? error.code : "AGENT_DUTY_SHEET_EXECUTION_FAILED";
        const state = dispatched ? "unknown" : code === "AGENT_DUTY_SHEET_CONFLICT" ? "conflict" : "failed";
        const saved = await dependencies.log.finish(input.operationId, state, code);
        return await dependencies.withOwner(auth, async () => saved);
      }
    });
  };
}

export const writeDutySheet = createDutySheetWriter({ owner: requirePrivateTelegramOwner, read: readDutySheet,
  execute: executeGoogleWorkspace, log: dutySheetWriteLog, withOwner: withDutyOwner });
