import type { Env } from "./env";
import { NotionClient } from "./notion";
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
		// waitUntil so the run-log write isn't cut off when scheduled() returns.
		ctx.waitUntil(runMode(env, mode, "Schedule"));
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		const mode = new URL(req.url).searchParams.get("mode");
		if (mode !== "post" && mode !== "snapshot") {
			return new Response("Pass ?mode=post or ?mode=snapshot", { status: 400 });
		}
		const result = await runMode(env, mode, "Manual");
		return Response.json({ mode, ...result });
	},
} satisfies ExportedHandler<Env>;

// Run one mode, then always write the run log (mirrors the Python actor's try/finally).
async function runMode(env: Env, mode: Mode, trigger: "Schedule" | "Manual"): Promise<RunResult> {
	const started = Date.now();
	let result: RunResult = { processed: 0, ok: 0, failed: 0, skipped: 0 };
	let error: string | null = null;
	try {
		result = mode === "post" ? await runPost(env) : await runSnapshot(env);
	} catch (exc) {
		error = exc instanceof Error ? exc.message : String(exc);
		console.error(`Run failed: ${error}`);
	} finally {
		const metrics = JSON.stringify({ duration_ms: Date.now() - started, ...result });
		try {
			await new NotionClient(env.NOTION_ACCESS_TOKEN).writeRunLog({
				status: error ? "Failed" : "Success",
				digest: `mode=${mode}`,
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
