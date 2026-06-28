import type { Env } from "./env";
import { NotionClient } from "./notion";
import { PinterestClient } from "./pinterest";
import type { RunResult } from "./post";

// =============================================================================
// Snapshot mode. For every Posted Pinterest pin due on the graduated schedule, pull
// date-range analytics and write a snapshot row. Mirrors the Python actor's window
// math (2-day Pinterest analytics lag) and should_snapshot cadence.
// =============================================================================

const WRITE_DELAY_MS = 350;
const ANALYTICS_LAG_DAYS = 2;

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

export async function runSnapshot(env: Env): Promise<RunResult> {
	console.log("=== PINTEREST SNAPSHOT ===");
	const notion = new NotionClient(env.NOTION_ACCESS_TOKEN);
	const pinterest = await PinterestClient.create(env);

	const pins = await notion.getPostedPins();
	console.log(`  ${pins.length} posted pins found`);

	const result: RunResult = { processed: 0, ok: 0, failed: 0, skipped: 0 };
	if (!pins.length) return result;

	const toSnapshot = pins.filter((p) => shouldSnapshot(p.published, p.lastShot));
	result.skipped = pins.length - toSnapshot.length;
	console.log(`  ${toSnapshot.length} to snapshot, ${result.skipped} skipped by schedule`);

	// End of window: today minus the 2-day analytics lag.
	const windowEnd = new Date(Date.now() - ANALYTICS_LAG_DAYS * DAY).toISOString().slice(0, 10);

	for (const pin of toSnapshot) {
		console.log(`  ${pin.title.slice(0, 50)}...`);

		// Window start: last snapshot date, else published date.
		const start = (pin.lastShot ?? pin.published)?.slice(0, 10);
		if (!start) {
			console.log("    No start date — skipping");
			result.skipped++;
			continue;
		}
		if (start >= windowEnd) {
			console.log("    Too recent for Pinterest analytics window — skipping");
			result.skipped++;
			continue;
		}

		const metrics = await pinterest.getPinAnalytics(pin.pinId, start, windowEnd);
		if (!Object.keys(metrics).length) {
			console.log("    No analytics returned");
			result.skipped++;
			continue;
		}

		const created = await notion.createSnapshot(pin.notionPageId, pin.title, metrics);
		result.processed++;
		if (created) {
			result.ok++;
			console.log(
				`    impressions=${metrics.IMPRESSION ?? 0} saves=${metrics.SAVE ?? 0} ` +
					`pin_clicks=${metrics.PIN_CLICK ?? 0} outbound=${metrics.OUTBOUND_CLICK ?? 0}`,
			);
			await notion.updatePage(pin.notionPageId, { "Last shot": { date: { start: new Date().toISOString() } } });
		} else {
			result.failed++;
		}
		await sleep(WRITE_DELAY_MS);
	}

	console.log(`  ✅ ${result.ok} snapshotted  ⏭️ ${result.skipped} skipped  ❌ ${result.failed} failed`);
	return result;
}

// Graduated schedule ported 1:1 from SolOSDK should_snapshot. False after 90 days; otherwise
// the cadence widens with post age.
function shouldSnapshot(published: string | null, lastShot: string | null): boolean {
	if (!published) return false;
	const now = Date.now();
	const age = now - Date.parse(published);
	if (age >= 90 * DAY) return false;

	const sinceLast = lastShot ? now - Date.parse(lastShot) : null;
	const due = (interval: number) => sinceLast === null || sinceLast >= interval;

	if (age < 3 * DAY) return true;
	if (age < 7 * DAY) return due(6 * HOUR);
	if (age < 15 * DAY) return due(12 * HOUR);
	if (age < 26 * DAY) return due(24 * HOUR);
	return due(7 * DAY);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
