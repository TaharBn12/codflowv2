/**
 * Hourly Telegram bot maintenance:
 *   1. expire overdue approvals + remind approvers before expiry;
 *   2. scan operational alerts (stuck shipments, stock, driver cash, …);
 *   3. flush queued digests for users in quiet hours / digest mode;
 *   4. send the weekly/monthly scheduled reports when due;
 *   5. prune old dedupe/queue rows.
 *
 * Every step is isolated: one failing step must not stop the others.
 */

import type { Env } from "@/types";
import { getDb } from "@/db";
import { sendApprovalReminders } from "@/endpoints/telegram-approvals/service";
import { runAlertScan, flushDigests, sendScheduledReports } from "@/endpoints/telegram-bot/notify";
import { pruneBotHousekeeping } from "@/endpoints/telegram-bot/store";

export async function runTelegramBotMaintenance(env: Env, now = new Date()): Promise<void> {
  try {
    const reminded = await sendApprovalReminders(env, now);
    if (reminded) console.log(`[cron:telegram] approvals processed=${reminded}`);
  } catch (error) {
    console.error("[cron:telegram] approval reminders failed", error);
  }

  try {
    await runAlertScan(env, now);
  } catch (error) {
    console.error("[cron:telegram] alert scan failed", error);
  }

  try {
    const flushed = await flushDigests(env, now);
    if (flushed) console.log(`[cron:telegram] digests flushed=${flushed}`);
  } catch (error) {
    console.error("[cron:telegram] digest flush failed", error);
  }

  try {
    await sendScheduledReports(env, now);
  } catch (error) {
    console.error("[cron:telegram] scheduled reports failed", error);
  }

  try {
    await pruneBotHousekeeping(getDb(env.DB), now);
  } catch (error) {
    console.error("[cron:telegram] housekeeping failed", error);
  }
}
