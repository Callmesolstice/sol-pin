import type { Env } from "./env";

// =============================================================================
// Pinterest API client. Owns exactly one external API (api.pinterest.com/v5).
//
// Tokens are read from the OAUTH_TOKENS KV namespace that the pinterest-oauth-worker
// populates (key "sol:pinterest_tokens"). On a 401 we refresh the access token using
// the shared app credentials and write the new tokens back to the SAME KV key, so the
// OAuth worker's store stays the single source of truth — no duplicate token store.
// =============================================================================

const PIN_BASE_URL = "https://api.pinterest.com/v5";

// Analytics pulled per pin. Date-range based (not lifetime) — summed per window each run.
export const PIN_METRICS = "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,TOTAL_COMMENTS";

// --- KV value shape written by pinterest-oauth-worker ---
interface StoredTokens {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	stored_at: string;
}

// --- Pinterest API response/payload shapes ---
interface OAuthTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

interface PinterestBoard {
	id: string;
	name: string;
}

interface BoardsResponse {
	items?: PinterestBoard[];
}

interface CreatePinResponse {
	id: string;
}

interface DailyMetric {
	data_status?: string;
	metrics?: Record<string, number>;
}

interface AnalyticsResponse {
	all?: { daily_metrics?: DailyMetric[] };
}

// A live client bound to one run. Holds the access token in memory so a mid-run refresh
// is visible to every later call, mirroring the Python actor's globals() token swap.
export class PinterestClient {
	private env: Env;
	private kvKey: string; // OAUTH_TOKENS key for this account's tokens
	private accessToken: string;
	private refreshToken: string;

	private constructor(env: Env, kvKey: string, tokens: StoredTokens) {
		this.env = env;
		this.kvKey = kvKey;
		this.accessToken = tokens.access_token;
		this.refreshToken = tokens.refresh_token;
	}

	static async create(env: Env, tokenState: string): Promise<PinterestClient> {
		const kvKey = `${tokenState}:pinterest_tokens`;
		const tokens = await env.OAUTH_TOKENS.get<StoredTokens>(kvKey, "json");
		if (!tokens?.access_token) {
			throw new Error(`No Pinterest tokens in OAUTH_TOKENS KV under "${kvKey}"`);
		}
		return new PinterestClient(env, kvKey, tokens);
	}

	// Exchange the refresh token for a new access token; persist back to OAUTH_TOKENS.
	private async refresh(): Promise<boolean> {
		const creds = btoa(`${this.env.PINTEREST_APP_ID}:${this.env.PINTEREST_APP_SECRET}`);
		const res = await fetch(`${PIN_BASE_URL}/oauth/token`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${creds}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: this.refreshToken,
			}),
		});
		if (!res.ok) {
			console.error(`Token refresh failed: ${res.status} ${await res.text()}`);
			return false;
		}
		const data = (await res.json()) as OAuthTokenResponse;
		if (!data.access_token) return false;

		this.accessToken = data.access_token;
		// Pinterest rotates the refresh token too; keep the old one if it didn't.
		if (data.refresh_token) this.refreshToken = data.refresh_token;

		const updated: StoredTokens = {
			access_token: this.accessToken,
			refresh_token: this.refreshToken,
			expires_in: data.expires_in,
			stored_at: new Date().toISOString(),
		};
		try {
			await this.env.OAUTH_TOKENS.put(this.kvKey, JSON.stringify(updated));
			console.log(`Pinterest token refreshed and written back to OAUTH_TOKENS["${this.kvKey}"]`);
		} catch (err) {
			// Refresh still succeeded in memory; this run can proceed.
			console.error(`KV write-back failed after refresh: ${err}`);
		}
		return true;
	}

	private async request(method: "GET" | "POST", path: string, init: RequestInit): Promise<Response> {
		const send = () =>
			fetch(`${PIN_BASE_URL}/${path}`, {
				...init,
				method,
				headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.accessToken}` },
			});
		let res = await send();
		if (res.status === 401) {
			console.log("Pinterest token expired, refreshing...");
			if (await this.refresh()) res = await send();
		}
		return res;
	}

	private async get(path: string, params?: Record<string, string>): Promise<unknown | null> {
		const qs = params ? `?${new URLSearchParams(params)}` : "";
		const res = await this.request("GET", `${path}${qs}`, {});
		if (!res.ok) {
			console.error(`Pinterest GET error [${path}]: ${res.status} ${await res.text()}`);
			return null;
		}
		return res.json();
	}

	private async post(path: string, payload: unknown): Promise<unknown | null> {
		const res = await this.request("POST", path, {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (res.status !== 200 && res.status !== 201) {
			console.error(`Pinterest POST error [${path}]: ${res.status} ${await res.text()}`);
			return null;
		}
		return res.json();
	}

	// Fetch all boards (single page of 100 — matches the Python actor's lookup).
	async getBoards(): Promise<PinterestBoard[]> {
		const data = (await this.get("boards", { page_size: "100" })) as BoardsResponse | null;
		return data?.items ?? [];
	}

	// Pull pin analytics over a date window and sum daily metrics that are READY.
	async getPinAnalytics(pinId: string, startDate: string, endDate: string): Promise<Record<string, number>> {
		const data = (await this.get(`pins/${pinId}/analytics`, {
			start_date: startDate,
			end_date: endDate,
			metric_types: PIN_METRICS,
		})) as AnalyticsResponse | null;
		if (!data) return {};

		const totals: Record<string, number> = {};
		for (const day of data.all?.daily_metrics ?? []) {
			if (day.data_status !== "READY") continue;
			for (const [metric, val] of Object.entries(day.metrics ?? {})) {
				totals[metric] = (totals[metric] ?? 0) + (val ?? 0);
			}
		}
		return totals;
	}

	// Create a pin. Fetch the image and upload it as base64 so Pinterest's CDN never
	// has to reach the source URL directly (mirrors the Python actor).
	async publishPin(
		boardId: string,
		title: string,
		description: string,
		mediaUrl: string,
		destLink: string | null,
	): Promise<string | null> {
		const img = await fetch(mediaUrl);
		if (!img.ok) {
			console.error(`Image fetch failed: ${img.status} ${mediaUrl.slice(0, 80)}`);
			return null;
		}
		const contentType = (img.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
		const data = bytesToBase64(new Uint8Array(await img.arrayBuffer()));

		const payload = {
			board_id: boardId,
			title: title.slice(0, 100),
			description: description.slice(0, 800),
			link: destLink ?? "",
			media_source: { source_type: "image_base64", content_type: contentType, data },
		};
		const result = (await this.post("pins", payload)) as CreatePinResponse | null;
		return result?.id ?? null;
	}
}

// btoa() can't take a raw byte string for binary data; encode in chunks to avoid
// blowing the call-stack / argument limits on large images.
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
