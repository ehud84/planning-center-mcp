export const PCO_API_ROOT = "https://api.planningcenteronline.com";
export const PRODUCTS = [
  "people",
  "services",
  "groups",
  "calendar",
  "check-ins",
  "registrations",
  "publishing",
] as const;
export type Product = (typeof PRODUCTS)[number];

export type JsonObject = Record<string, any>;
export type Params = Record<string, string | number | boolean | undefined | null>;

export interface PcoResource {
  id: string;
  type: string;
  attributes?: JsonObject;
  relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] | null }>;
  links?: JsonObject;
}

export interface PcoDocument {
  data: PcoResource | PcoResource[];
  included?: PcoResource[];
  meta?: { total_count?: number; count?: number; next?: { offset?: number } } & JsonObject;
  links?: JsonObject;
}

export type PcoAuth = { kind: "basic"; id: string; secret: string } | { kind: "bearer"; token: string };

const ERROR_MESSAGES: Record<number, string> = {
  400: "Planning Center rejected the request",
  401: "Planning Center authentication failed; sign in again",
  403: "Planning Center denied access to this resource (check your Planning Center permissions)",
  404: "Planning Center resource not found; check the supplied ID",
  429: "Planning Center rate limit exceeded; wait before retrying",
};

export class PcoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PcoClient {
  private readonly authHeader: string;

  constructor(auth: PcoAuth) {
    this.authHeader = auth.kind === "basic" ? `Basic ${btoa(`${auth.id}:${auth.secret}`)}` : `Bearer ${auth.token}`;
  }

  async request(
    product: Product,
    path: string,
    { method = "GET", params, body }: { method?: string; params?: Params; body?: unknown } = {},
  ): Promise<PcoDocument | null> {
    const url = new URL(`${PCO_API_ROOT}/${product}/v2/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          "User-Agent": "planning-center-mcp/2.0 (pco.bellicosechurch.org)",
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("Retry-After")) || 20;
        await response.body?.cancel();
        await sleep(Math.min(retryAfter, 30) * 1000);
        continue;
      }

      if (!response.ok) throw new PcoError(await formatError(response), response.status);
      await this.throttle(response);
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? (JSON.parse(text) as PcoDocument) : null;
    }
  }

  get(product: Product, path: string, params?: Params) {
    return this.request(product, path, { params }) as Promise<PcoDocument>;
  }

  /** Follow offset pagination until every record (up to `max`) is collected. */
  async getAll(product: Product, path: string, params: Params = {}, max = 5000) {
    const data: PcoResource[] = [];
    const included: PcoResource[] = [];
    let offset = 0;
    while (data.length < max) {
      const page = await this.get(product, path, { per_page: 100, ...params, offset });
      const rows = asArray(page.data);
      data.push(...rows);
      included.push(...(page.included ?? []));
      offset += rows.length;
      if (!rows.length || offset >= (page.meta?.total_count ?? offset)) break;
    }
    return { data, included };
  }

  /** Slow down when the shared 100-requests-per-20s window is nearly used up. */
  private async throttle(response: Response) {
    const count = Number(response.headers.get("X-PCO-API-Request-Rate-Count"));
    const limit = Number(response.headers.get("X-PCO-API-Request-Rate-Limit"));
    if (count && limit && count >= limit - 5) {
      const period = parseInt(response.headers.get("X-PCO-API-Request-Rate-Period") ?? "20", 10) || 20;
      await sleep((period * 1000) / 4);
    }
  }
}

async function formatError(response: Response): Promise<string> {
  const base = ERROR_MESSAGES[response.status] ?? `Planning Center API request failed with status ${response.status}`;
  try {
    const payload = (await response.json()) as { errors?: { detail?: string; title?: string }[] };
    const details = (payload.errors ?? [])
      .slice(0, 3)
      .map((e) => e.detail || e.title)
      .filter(Boolean);
    return details.length ? `${base}: ${details.join("; ")}` : base;
  } catch {
    return base;
  }
}

export function asArray(data: PcoDocument["data"] | undefined): PcoResource[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

export function relId(record: PcoResource, name: string): string | null {
  const data = record.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? String(data.id) : null;
}

export function relIds(record: PcoResource, name: string): string[] {
  const data = record.relationships?.[name]?.data;
  return Array.isArray(data) ? data.map((d) => String(d.id)) : [];
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
