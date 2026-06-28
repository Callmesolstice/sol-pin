import type { Env } from "./env";

// Thin entry point. scheduled() dispatches post/snapshot by cron; fetch() is a manual
// test trigger. Mode logic + run-log wrapper are wired in Joint 6.

export default {
	async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
		// Joint 6: dispatch on _event.cron, wrap in run-log try/finally.
	},

	async fetch(_req: Request, _env: Env): Promise<Response> {
		// Joint 6: ?mode=post|snapshot manual trigger.
		return new Response("sol-pin-worker (scaffold)", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
