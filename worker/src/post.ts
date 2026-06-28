import type { Env } from "./env";
import type { Account } from "./account";
import { NotionClient, type ScheduledPin } from "./notion";
import { PinterestClient } from "./pinterest";

// =============================================================================
// Post mode. Orchestrates Notion + Pinterest: publish every Scheduled & due pin,
// resolve its board (KV, registering via Pinterest on a new_board), and write the
// result back to Notion. Retries / kills on failure, mirroring the Python actor.
// =============================================================================

const WRITE_DELAY_MS = 350; // ~3 Notion writes/sec
const MAX_RETRIES = 3;

export interface RunResult {
	processed: number; // pages touched
	ok: number;
	failed: number;
	skipped: number;
}

export async function runPost(env: Env, account: Account): Promise<RunResult> {
	console.log("=== PINTEREST POST ===");
	const notion = new NotionClient(account.notionToken(env), account.dbs, account.titleProp);
	const pinterest = await PinterestClient.create(env, account.tokenState);

	const pins = await notion.getScheduledPins();
	console.log(`  ${pins.length} pin(s) scheduled to post`);

	const result: RunResult = { processed: 0, ok: 0, failed: 0, skipped: 0 };
	for (const pin of pins) {
		const success = await postSinglePin(env, account, notion, pinterest, pin);
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
	account: Account,
	notion: NotionClient,
	pinterest: PinterestClient,
	pin: ScheduledPin,
): Promise<boolean> {
	console.log(`  Posting: ${pin.title.slice(0, 50)}...`);

	const boardId = await resolveBoardId(env, account, pinterest, notion, pin.notionPageId, pin.boardName, pin.newBoard);
	if (!boardId) {
		console.log(`  No board ID for '${pin.boardName}'`);
		await applyRetry(notion, pin.notionPageId, pin.retryCount);
		return false;
	}

	const pinId = await pinterest.publishPin(boardId, pin.title, pin.caption, pin.mediaUrl, pin.destLink, pin.altText);
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

// Board name -> board id. KV first (boards are prefilled per account). On a miss, the
// new_board property holds a LINK to the board: parse it, confirm the board exists on
// Pinterest, correct the Board option name if it's off, and cache the mapping so future
// pins skip the lookup. Key shape matches the Apify pinterest-boards store.
async function resolveBoardId(
	env: Env,
	account: Account,
	pinterest: PinterestClient,
	notion: NotionClient,
	pageId: string,
	boardName: string,
	newBoardLink: string | null,
): Promise<string | null> {
	if (!boardName) return null;
	const key = boardKvKey(account.boardTenant, boardName);

	const cached = await env.PINTEREST_BOARDS.get(key);
	if (cached) return cached;

	if (!newBoardLink) {
		console.log(`  Board '${key}' not in KV and no new_board link — skipping`);
		return null;
	}

	console.log(`  New board for '${key}' — verifying from link...`);
	const slug = await boardSlugFromLink(newBoardLink);
	const boards = await pinterest.getBoards();
	// Match the link's board slug against each board's normalized name; fall back to the
	// Board option name in case the link can't be parsed.
	const match =
		(slug && boards.find((b) => normalizeName(b.name) === slug)) ||
		boards.find((b) => b.name.trim().toLowerCase() === boardName.trim().toLowerCase());
	if (!match) {
		console.log(`  Could not verify a board from new_board link (Board='${boardName}')`);
		return null;
	}

	// Correct the Board option in Notion if its name doesn't match Pinterest's.
	let finalKey = key;
	if (match.name !== boardName) {
		console.log(`  Correcting Board '${boardName}' -> '${match.name}'`);
		await notion.updatePage(pageId, { Board: { select: { name: match.name } } });
		finalKey = boardKvKey(account.boardTenant, match.name);
	}

	await env.PINTEREST_BOARDS.put(finalKey, match.id);
	console.log(`  KV saved: '${finalKey}' -> ${match.id}`);
	return match.id;
}

// Pull the board slug out of a Pinterest board link, following a pin.it short link to its
// canonical URL first. Returns a normalized slug (lowercase, alphanumerics only).
async function boardSlugFromLink(link: string): Promise<string | null> {
	try {
		let url = new URL(link.trim());
		if (url.hostname.includes("pin.it")) {
			const res = await fetch(link, { redirect: "follow" });
			url = new URL(res.url);
		}
		// Pinterest board URLs look like /<user>/<board-slug>/ — take the 2nd path segment.
		const segs = url.pathname.split("/").filter(Boolean);
		const slug = segs.length >= 2 ? segs[1] : segs[0];
		return slug ? normalizeName(slug) : null;
	} catch {
		return null;
	}
}

// Normalize a board name or url slug for comparison: lowercase, strip non-alphanumerics.
// e.g. "solstice.png" and the url slug "solsticepng" both become "solsticepng".
function normalizeName(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, "");
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
function boardKvKey(tenant: string, boardName: string): string {
	const safe = boardName.replace(/[^a-zA-Z0-9!_.'()-]/g, "_");
	return `${tenant}.${safe}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
