/** Root-only owner context shared by interactive duty tools and their trusted approval presentation. */
import type { SessionContext } from "eve/context";
import { AppError } from "../app-error.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { requirePrivateTelegramOwner } from "../family-context.js";

export function requireInteractiveDutyOwner(ctx: Pick<SessionContext, "session">) {
  const auth = requirePrivateTelegramOwner(ctx);
  if (ctx.session.parent || isScheduledSession(ctx)) throw new AppError("AGENT_DUTY_INTERACTIVE_OWNER_REQUIRED", "Это действие доступно владельцу в обычном личном диалоге");
  return auth;
}
