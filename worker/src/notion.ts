// =============================================================================
// Notion API client. Owns exactly one external API (api.notion.com/v1).
//
// Ports the SolOSDK helpers sol-pin used (query_db, create_page, update_page, file_url)
// plus the actor's own Notion-shaped queries and writers. Database IDs are per-account
// (each Pinterest account has its own Notion workspace) — see account.ts. No env vars.
// =============================================================================

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Live Post Snapshots schema names the content-piece relation "→ Content piece"
// (arrow-prefixed), not "Content piece" as the Python actor assumed.
const SNAPSHOT_RELATION = "→ Content piece";

// The content databases one account reads/writes in its own Notion workspace. The Agent
// Run Log is NOT here — it's a single personal monitoring DB shared across all accounts
// (see writeRunLog / RUN_LOG in account.ts).
export interface NotionDbs {
	contentPieces: string;
	snapshots?: string; // omitted for accounts with no Post Snapshots DB (they skip snapshot mode)
}

// --- Notion property shapes we read off Content Pieces / Snapshots ---
interface RichTextItem {
	plain_text: string;
}
interface NotionFile {
	file?: { url: string };
	external?: { url: string };
}
interface NotionProps {
	[key: string]: any;
}
interface NotionPage {
	id: string;
	properties: NotionProps;
}

// --- Domain objects returned to the orchestration layer ---
export interface ScheduledPin {
	notionPageId: string;
	title: string;
	caption: string;
	altText: string | null;
	mediaUrl: string;
	destLink: string | null;
	boardName: string;
	newBoard: string | null;
	retryCount: number;
}
export interface PostedPin {
	notionPageId: string;
	pinId: string;
	title: string;
	published: string | null;
	lastShot: string | null;
}

export class NotionClient {
	constructor(
		private token: string,
		private dbs: NotionDbs,
		// Content-piece title property name — "Piece" for sol, "Title" for olive.
		private titleProp: string,
	) {}

	private headers(): HeadersInit {
		return notionHeaders(this.token);
	}

	// Fully paginated query with any Notion filter (+ optional sorts).
	private async queryDb(dbId: string, filter: unknown, sorts?: unknown[]): Promise<NotionPage[]> {
		const pages: NotionPage[] = [];
		let cursor: string | undefined;
		do {
			const body: Record<string, unknown> = { filter };
			if (sorts) body.sorts = sorts;
			if (cursor) body.start_cursor = cursor;
			const res = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
			const data = (await res.json()) as { results: NotionPage[]; has_more: boolean; next_cursor: string | null };
			pages.push(...data.results);
			cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
		} while (cursor);
		return pages;
	}

	async createPage(dbId: string, properties: unknown): Promise<string | null> {
		const res = await fetch(`${NOTION_BASE}/pages`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ parent: { database_id: dbId }, properties }),
		});
		if (!res.ok) {
			console.error(`Notion create failed: ${res.status} ${await res.text()}`);
			return null;
		}
		return ((await res.json()) as { id: string }).id;
	}

	async updatePage(pageId: string, properties: unknown): Promise<boolean> {
		const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
			method: "PATCH",
			headers: this.headers(),
			body: JSON.stringify({ properties }),
		});
		if (!res.ok) console.error(`Notion update failed: ${res.status} ${await res.text()}`);
		return res.ok;
	}

	// --- Content Pieces queries ---

	async getScheduledPins(): Promise<ScheduledPin[]> {
		const today = new Date().toISOString().slice(0, 10);
		const pages = await this.queryDb(this.dbs.contentPieces, {
			and: [
				{ property: "Platform", select: { equals: "Pinterest" } },
				{ property: "Stage", status: { equals: "Scheduled" } },
				{ property: "Post ID", rich_text: { is_empty: true } },
				{ property: "Scheduled time", date: { on_or_before: today } },
			],
		});

		const pins: ScheduledPin[] = [];
		for (const page of pages) {
			const p = page.properties;
			const title = plainText(p[this.titleProp]?.title) || "Untitled";
			// Media file (Files & media) preferred; fall back to Media link (rich_text).
			const mediaUrl = fileUrl(p["Media file"]) ?? plainText(p["Media link"]?.rich_text) ?? "";
			const boardName = p.Board?.select?.name ?? "";

			if (!mediaUrl) {
				console.log(`  Skipping '${title}' — no Media file or Media link`);
				continue;
			}
			if (!boardName) {
				console.log(`  Skipping '${title}' — no Board selected`);
				continue;
			}
			pins.push({
				notionPageId: page.id,
				title,
				caption: plainText(p.Caption?.rich_text),
				altText: plainText(p["Alt text"]?.rich_text) || null,
				mediaUrl,
				destLink: p["Dest. link"]?.url ?? null,
				boardName,
				newBoard: plainText(p.new_board?.rich_text) || null,
				retryCount: p["Retry count"]?.number ?? 0,
			});
		}
		return pins;
	}

	async getPostedPins(): Promise<PostedPin[]> {
		const pages = await this.queryDb(this.dbs.contentPieces, {
			and: [
				{ property: "Platform", select: { equals: "Pinterest" } },
				{ property: "Stage", status: { equals: "Posted" } },
				{ property: "Post ID", rich_text: { is_not_empty: true } },
			],
		});

		const pins: PostedPin[] = [];
		for (const page of pages) {
			const p = page.properties;
			const rt = (p["Post ID"]?.rich_text ?? []) as RichTextItem[];
			if (!rt.length) continue;
			pins.push({
				notionPageId: page.id,
				pinId: rt[0].plain_text,
				title: plainText(p[this.titleProp]?.title) || "Untitled",
				published: p.Published?.date?.start ?? null,
				lastShot: p["Last shot"]?.date?.start ?? null,
			});
		}
		return pins;
	}

	// Previous snapshot totals for delta calc. Sort by Created time desc, take the latest
	// (fidelity-safe vs the Python actor's reliance on unsorted [-1]).
	async getLastSnapshot(notionPageId: string): Promise<Record<string, number>> {
		if (!this.dbs.snapshots) return {};
		const results = await this.queryDb(
			this.dbs.snapshots,
			{ property: SNAPSHOT_RELATION, relation: { contains: notionPageId } },
			[{ timestamp: "created_time", direction: "descending" }],
		);
		if (!results.length) return {};
		const p = results[0].properties;
		return {
			impressions: p.Impressions?.number ?? 0,
			saves: p.Saves?.number ?? 0,
			pin_clicks: p["Pin clicks"]?.number ?? 0,
			outbound: p["Out clicks"]?.number ?? 0,
			comments: p.Comments?.number ?? 0,
		};
	}

	async createSnapshot(notionPageId: string, title: string, metrics: Record<string, number>): Promise<boolean> {
		const snapshotsDb = this.dbs.snapshots;
		if (!snapshotsDb) return false; // account has no Post Snapshots DB
		const snapshotTitle = `${title} — ${new Date().toISOString().slice(0, 10)}`;
		const prev = await this.getLastSnapshot(notionPageId);

		const impressions = metrics.IMPRESSION ?? 0;
		const saves = metrics.SAVE ?? 0;
		const pinClicks = metrics.PIN_CLICK ?? 0;
		const outbound = metrics.OUTBOUND_CLICK ?? 0;
		const comments = metrics.TOTAL_COMMENTS ?? 0;

		const props = {
			Piece: { title: [{ text: { content: snapshotTitle } }] },
			Platform: { select: { name: "Pinterest" } },
			[SNAPSHOT_RELATION]: { relation: [{ id: notionPageId }] },
			Impressions: { number: impressions },
			Saves: { number: saves },
			"Pin clicks": { number: pinClicks },
			"Out clicks": { number: outbound },
			Comments: { number: comments },
			impressions_dt: { number: impressions - (prev.impressions ?? 0) },
			saves_dt: { number: saves - (prev.saves ?? 0) },
			pin_klk_dt: { number: pinClicks - (prev.pin_clicks ?? 0) },
			out_klk_dt: { number: outbound - (prev.outbound ?? 0) },
			comments_dt: { number: comments - (prev.comments ?? 0) },
		};
		return (await this.createPage(snapshotsDb, props)) !== null;
	}

}

// --- Agent Run Log (personal monitoring layer, shared across accounts) ---
//
// Standalone on purpose: it's written with a fixed monitoring token to one fixed DB,
// independent of which account's content workspace produced the run.
export async function writeRunLog(
	token: string,
	runLogDb: string,
	opts: {
		status: "Success" | "Failed";
		digest: string;
		pagesTouched: number;
		errors?: string | null;
		metrics?: string | null;
		trigger?: "Schedule" | "Manual";
	},
): Promise<boolean> {
	// Completed at is America/Phoenix (UTC-7, no DST), matching the Python actor.
	const phx = new Date(Date.now() - 7 * 3600 * 1000);
	const completedAt = phx.toISOString().replace("Z", "-07:00");
	const runTitle = `sol-pin run — ${formatPhoenix(phx)}`;

	const props: NotionProps = {
		Run: { title: [{ text: { content: runTitle } }] },
		Status: { select: { name: opts.status } },
		Trigger: { select: { name: opts.trigger ?? "Schedule" } },
		Digest: { rich_text: [{ text: { content: opts.digest } }] },
		"Pages Touched": { number: opts.pagesTouched },
		"Completed at": { date: { start: completedAt } },
	};
	if (opts.errors) props.Errors = { rich_text: [{ text: { content: opts.errors.slice(0, 2000) } }] };
	if (opts.metrics) props.Metrics = { rich_text: [{ text: { content: opts.metrics } }] };

	const res = await fetch(`${NOTION_BASE}/pages`, {
		method: "POST",
		headers: notionHeaders(token),
		body: JSON.stringify({ parent: { database_id: runLogDb }, properties: props }),
	});
	if (!res.ok) {
		console.error(`Run log write failed: ${res.status} ${await res.text()}`);
		return false;
	}
	console.log(`Run log entry created: ${runTitle}`);
	return true;
}

// --- helpers (ported from SolOSDK file_url / plain-text extraction) ---

function notionHeaders(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"Notion-Version": NOTION_VERSION,
	};
}

export function fileUrl(filesProp: any): string | null {
	const files: NotionFile[] = filesProp?.files ?? [];
	for (const f of files) {
		const url = f.file?.url ?? f.external?.url;
		if (url) return url;
	}
	return null;
}

function plainText(richText: RichTextItem[] | undefined): string {
	if (!richText?.length) return "";
	return richText.map((r) => r.plain_text).join("");
}

// "2026-06-27 3:45pm" style stamp, matching Python's %Y-%m-%d %-I:%M%p lowercased.
function formatPhoenix(d: Date): string {
	const date = d.toISOString().slice(0, 10);
	let h = d.getUTCHours();
	const m = String(d.getUTCMinutes()).padStart(2, "0");
	const ampm = h >= 12 ? "pm" : "am";
	h = h % 12 || 12;
	return `${date} ${h}:${m}${ampm}`;
}
