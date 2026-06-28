import type { Env } from "./env";
import { NotionClient, type ScheduledPin } from "./notion";
import { PinterestClient } from "./pinterest";

// =============================================================================
// Post mode. Orchestrates Notion + Pinterest: publish every Scheduled & due pin,
// resolve its board (KV, registering via Pinterest on a new_board), and write the
// result back to Notion. Retries / kills on failure, mirroring the Python actor.
// =============================================================================

const TENANT = "sol";
const WRITE_DELAY_MS = 350; // ~3 Notion writes/sec
const MAX_RETRIES = 3;

export interface RunResult {
	processed: number; // pages touched
	ok: number;
	failed: number;
	skipped: number;
}

export async function runPost(env: Env): Promise<RunResult> {
	console.log("=== PINTEREST POST ===");
	const notion = new NotionClient(env.NOTION_ACCESS_TOKEN);
	const pinterest = await PinterestClient.create(env);

	const pins = await notion.getScheduledPins();
	console.log(`  ${pins.length} pin(s) scheduled to post`);

	const result: RunResult = { processed: 0, ok: 0, failed: 0, skipped: 0 };
	for (const pin of pins) {
		const success = await postSinglePin(env, notion, pinterest, pin);
		result.processed++;
		if (success) result.ok++;
		else result.failed++;
		await sleep(WRITE_DELAY_MS);
	}
	console.log(`  ✅ ${result.ok} posted  ❌ ${result.failed} failed`);
	return result;
}

async function postSinglePin(
	env: Env,
	notion: NotionClient,
	pinterest: PinterestClient,
	pin: ScheduledPin,
): Promise<boolean> {
	console.log(`  Posting: ${pin.title.slice(0, 50)}...`);

	const boardId = await resolveBoardId(env, pinterest, pin.boardName, pin.newBoard);
	if (!boardId) {
		console.log(`  No board ID for '${pin.boardName}'`);
		await applyRetry(notion, pin.notionPageId, pin.retryCount);
		return false;
	}

	const pinId = await pinterest.publishPin(boardId, pin.title, pin.caption, pin.mediaUrl, pin.destLink);
	if (!pinId) {
		console.log(`  Pinterest returned no pin ID for '${pin.title}'`);
		await applyRetry(notion, pin.notionPageId, pin.retryCount);
		return false;
	}

	const permalink = `https://www.pinterest.com/pin/${pinId}/`;
	const updates: Record<string, unknown> = {
		Stage: { status: { name: "Posted" } },
		"Post ID": { rich_text: [{ text: { content: pinId } }] },
		"Post link": { url: permalink },
		Published: { date: { start: new Date().toISOString().slice(0, 10) } },
	};
	// Clear new_board once it's been registered, so it doesn't re-trigger lookups.
	if (pin.newBoard) updates.new_board = { rich_text: [] };

	const updated = await notion.updatePage(pin.notionPageId, updates);
	console.log(updated ? `  Posted ✅  Pin ID: ${pinId}` : `  Posted but Notion update failed for '${pin.title}'`);
	return true;
}

// Board name -> board id. KV first; on a miss with new_board set, look the board up on
// Pinterest by name and cache it. Key shape matches the Apify pinterest-boards store.
async function resolveBoardId(
	env: Env,
	pinterest: PinterestClient,
	boardName: string,
	newBoard: string | null,
): Promise<string | null> {
	if (!boardName) return null;
	const key = boardKvKey(boardName);

	const cached = await env.PINTEREST_BOARDS.get(key);
	if (cached) return cached;

	if (newBoard) {
		console.log(`  Unknown board '${key}' — fetching from Pinterest API...`);
		const boards = await pinterest.getBoards();
		const match = boards.find((b) => b.name.trim().toLowerCase() === boardName.trim().toLowerCase());
		if (match) {
			await env.PINTEREST_BOARDS.put(key, match.id);
			console.log(`  KV saved: '${key}' -> ${match.id}`);
			return match.id;
		}
		console.log(`  Board '${key}' not found on Pinterest — check the name matches exactly`);
	} else {
		console.log(`  Board '${key}' not in KV and no new_board provided — skipping`);
	}
	return null;
}

// On failure: bump Retry count. Under the cap, reschedule +5 min; at the cap, mark Killed
// so the row surfaces instead of looping silently.
async function applyRetry(notion: NotionClient, pageId: string, retryCount: number): Promise<void> {
	const next = retryCount + 1;
	if (next >= MAX_RETRIES) {
		await notion.updatePage(pageId, {
			Stage: { status: { name: "Killed" } },
			"Retry count": { number: next },
		});
		console.log(`  Retry count hit ${next} — marking Killed`);
	} else {
		const bump = new Date(Date.now() + 5 * 60 * 1000).toISOString();
		await notion.updatePage(pageId, {
			"Retry count": { number: next },
			"Scheduled time": { date: { start: bump } },
		});
		console.log(`  Retry ${next}/${MAX_RETRIES} — rescheduled +5 min`);
	}
}

// Apify KV keys allowed a-zA-Z0-9!-_.'() and used "." as the tenant separator; keep the
// exact same sanitization so existing/registered keys line up.
function boardKvKey(boardName: string): string {
	const safe = boardName.replace(/[^a-zA-Z0-9!_.'()-]/g, "_");
	return `${TENANT}.${safe}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
