import type { Env } from "./env";
import { ACCOUNTS, RUN_LOG, type Account } from "./account";
import { writeRunLog } from "./notion";
import { runPost, type RunResult } from "./post";
import { runSnapshot } from "./snapshot";

// =============================================================================
// Thin entry point. scheduled() dispatches post/snapshot by cron expression;
// fetch() is a manual ?mode= trigger for testing. Every run — success or failure —
// writes one Agent Run Log row via the shared runMode() try/finally wrapper.
// =============================================================================

type Mode = "post" | "snapshot";

// Cron expression -> mode (must match the two entries in wrangler.jsonc triggers.crons).
const CRON_MODES: Record<string, Mode> = {
	"*/30 * * * *": "post",
	"0 */6 * * *": "snapshot",
};

export default {
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const mode = CRON_MODES[event.cron];
		if (!mode) {
			console.error(`No mode mapped for cron "${event.cron}"`);
			return;
		}
		// waitUntil so the run-log writes aren't cut off when scheduled() returns.
		ctx.waitUntil(runAllAccounts(env, mode, "Schedule"));
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		// Gate the manual trigger: token via ?token= or "X-Trigger-Token" header.
		const token = url.searchParams.get("token") ?? req.headers.get("x-trigger-token");
		if (!env.TRIGGER_SECRET || token !== env.TRIGGER_SECRET) {
			return new Response("Unauthorized", { status: 401 });
		}
		const mode = url.searchParams.get("mode");
		if (mode !== "post" && mode !== "snapshot") {
			return new Response("Pass ?mode=post or ?mode=snapshot", { status: 400 });
		}
		const results = await runAllAccounts(env, mode, "Manual");
		return Response.json({ mode, results });
	},
} satisfies ExportedHandler<Env>;

// Run a mode for every configured account, one at a time (one shared Pinterest app,
// so keep concurrency low). Each account writes its own run-log row in its own workspace.
async function runAllAccounts(env: Env, mode: Mode, trigger: "Schedule" | "Manual") {
	const results: Array<{ account: string; result: RunResult }> = [];
	for (const account of ACCOUNTS) {
		// Snapshot mode needs a Post Snapshots DB; skip accounts that don't have one.
		if (mode === "snapshot" && !account.dbs.snapshots) {
			console.log(`Skipping snapshot for ${account.tokenState} — no snapshots DB`);
			continue;
		}
		results.push({ account: account.tokenState, result: await runMode(env, mode, trigger, account) });
	}
	return results;
}

// Run one mode for one account, then always write the run log (mirrors the Python
// actor's try/finally).
async function runMode(env: Env, mode: Mode, trigger: "Schedule" | "Manual", account: Account): Promise<RunResult> {
	const started = Date.now();
	let result: RunResult = { processed: 0, ok: 0, failed: 0, skipped: 0 };
	let error: string | null = null;
	try {
		result = mode === "post" ? await runPost(env, account) : await runSnapshot(env, account);
	} catch (exc) {
		error = exc instanceof Error ? exc.message : String(exc);
		console.error(`Run failed: ${error}`);
	} finally {
		const metrics = JSON.stringify({ duration_ms: Date.now() - started, ...result });
		try {
			await writeRunLog(RUN_LOG.token(env), RUN_LOG.db, {
				status: error ? "Failed" : "Success",
				digest: `mode=${mode} account=${account.tokenState}`,
				pagesTouched: result.processed,
				errors: error,
				metrics,
				trigger,
			});
		} catch (logErr) {
			console.error(`Run log write failed: ${logErr}`);
		}
	}
	return result;
}
