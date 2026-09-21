import { sendDailyReportIfDue } from "@/lib/daily-report";
import type { Env } from "@/types";

export async function runDailyReport(env: Env): Promise<void> {
  try {
    const sent = await sendDailyReportIfDue(env);
    if (sent) console.log("[cron:daily-report] report sent");
  } catch (error) {
    console.error("[cron:daily-report] failed", error);
  }
}
