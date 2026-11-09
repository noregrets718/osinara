/** A dedicated PostgreSQL session prevents review of a locally active write without occupying the pool. */
import { Client } from "pg";
import type { ToolContext } from "eve/tools";
import { AppError } from "../app-error.js";
import { poolConnection } from "../database.js";

export type DutySheetWorker = { signal: AbortSignal; check(): Promise<void> };
export async function withDutySheetWorker<T>(id: string, action: (worker: DutySheetWorker) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new AppError("AGENT_DATABASE_CONFIG_MISSING", "Не задано подключение к базе данных");
  const client = new Client({ ...poolConnection(url), application_name: "duty-sheet-worker", connectionTimeoutMillis: 5000, query_timeout: 5000, keepAlive: true });
  const lost = new AbortController();
  const ended = () => lost.abort(new AppError("AGENT_DUTY_SHEET_WORKER_LOST", "Соединение блокировки потеряно. Проверьте журнал операции"));
  client.on("error", ended);
  client.on("end", ended);
  try {
    await client.connect();
    const result = await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held", [`duty-sheet-worker:${id}`]);
    if (!result.rows[0].held) throw new AppError("AGENT_DUTY_SHEET_WORKER_ACTIVE", "Операция ещё выполняется. Дождитесь завершения перед сверкой");
    return await action({ signal: lost.signal, async check() {
      lost.signal.throwIfAborted();
      await client.query("SELECT 1");
      lost.signal.throwIfAborted();
    } });
  } finally {
    await client.end().catch(() => undefined); // Session termination releases its advisory lock.
  }
}

export function dutySheetWorkerContext(ctx: ToolContext, worker: DutySheetWorker): ToolContext {
  const scoped = Object.create(ctx) as ToolContext;
  Object.defineProperty(scoped, "abortSignal", { value: AbortSignal.any([ctx.abortSignal, worker.signal]) });
  return scoped;
}
