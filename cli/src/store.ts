// The store: an R2 bucket of the install (setting `store`, off by default). See worker/src/store.ts.
//
// init and upgrade add the binding to the copied wrangler.jsonc and make the bucket before the deploy. The bucket
// has a fixed name, <worker>-store, so uninstall and the docs can name it. uninstall keeps it: its files are
// the user's, and R2 deletes only an empty bucket.
import { CliError } from "./errors.js";
import { lastErrorLine, type Wrangler } from "./wrangler.js";

/** The binding name the Worker reads (env.STORE). */
export const STORE_BINDING = "STORE";

/** <worker>-store, as R2 allows: 3 to 63 lowercase letters, digits and hyphens. */
export function storeBucketName(worker: string): string {
  const base = worker
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 57)
    .replace(/-+$/, "");
  return `${base || "cf-opencode"}-store`;
}

/** Add the store binding to a wrangler.jsonc text, before "containers". The text keeps its comments. */
export function addStoreBinding(jsonc: string, bucket: string): string {
  if (jsonc.includes('"r2_buckets"')) return jsonc;
  const at = jsonc.search(/^\s*"containers"\s*:/m);
  if (at < 0) throw new CliError('no "containers" in worker/wrangler.jsonc', "reinstall cf-opencode");
  const line = `  // The store (setting store): files that outlive a workspace.\n  "r2_buckets": [{ "binding": "${STORE_BINDING}", "bucket_name": "${bucket}" }],\n`;
  const start = jsonc.lastIndexOf("\n", at) + 1;
  return `${jsonc.slice(0, start)}${line}${jsonc.slice(start)}`;
}

/** Make the bucket when it does not exist. An existing bucket of this account is fine. */
export async function ensureStoreBucket(
  w: Wrangler,
  bucket: string,
  step: (l: string) => void,
): Promise<void> {
  const r = await w.run(["r2", "bucket", "create", bucket], { timeoutMs: 120_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0) {
    step(`✓ Store: made the R2 bucket ${bucket}`);
    return;
  }
  if (/already exists|10004/i.test(out)) {
    step(`✓ Store: R2 bucket ${bucket}`);
    return;
  }
  if (/enable R2|10042/i.test(out))
    throw new CliError(
      "R2 is not turned on in this Cloudflare account, so the store has no bucket",
      "turn on R2 in the dashboard (R2 Object Storage), then rerun; or set store to false",
    );
  if (/auth|permission|10000|403/i.test(out))
    throw new CliError(
      `the Cloudflare login cannot make R2 buckets (${lastErrorLine(out)})`,
      "add Workers R2 Storage Write to the API token, then rerun; or set store to false",
    );
  throw new CliError(
    `making the R2 bucket ${bucket} failed: ${lastErrorLine(out)}`,
    "rerun; or set store to false",
  );
}

/** The line uninstall prints about the bucket, or undefined when there is none. */
export async function storeBucketNote(w: Wrangler, worker: string): Promise<string | undefined> {
  const bucket = storeBucketName(worker);
  const r = await w.run(["r2", "bucket", "info", bucket], { timeoutMs: 60_000 }).catch(() => undefined);
  if (r?.code !== 0) return undefined;
  return `Kept: the store, R2 bucket ${bucket}, with its files. To delete it, empty it in the dashboard, then: npx wrangler r2 bucket delete ${bucket}`;
}

export interface StoreObject {
  key: string;
  size: number;
  uploaded: string;
}

export interface StoreDeps {
  url: string;
  token: string;
  fetchFn?: typeof fetch;
}

/** GET /v1/store: every name, page by page. */
export async function listStore(d: StoreDeps, prefix?: string): Promise<StoreObject[]> {
  const all: StoreObject[] = [];
  let cursor: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) });
    const body = (await (await storeCall(d, "GET", `/v1/store?${q}`)).json()) as {
      objects: StoreObject[];
      cursor?: string;
    };
    all.push(...body.objects);
    if (!body.cursor) return all;
    cursor = body.cursor;
  }
}

export async function removeStore(d: StoreDeps, key: string): Promise<void> {
  await storeCall(d, "DELETE", `/v1/store/${encodeKey(key)}`);
}

export const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** One control request for cp and the store. The token goes in a header, never in the URL. */
export async function storeCall(
  d: StoreDeps,
  method: string,
  path: string,
  init: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await (d.fetchFn ?? fetch)(`${d.url.replace(/\/$/, "")}${path}`, {
      method,
      ...(init.body !== undefined ? { body: init.body } : {}),
      headers: { authorization: `Bearer ${d.token}`, ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new CliError(
      `cannot reach ${d.url} from this machine (${e instanceof Error ? e.message : String(e)})`,
      "run the command again; if it repeats, check the network with cf-opencode doctor",
    );
  }
  if (res.status === 401)
    throw new CliError(
      "the Worker refused the control token on this machine",
      "copy ~/.cf-opencode/control-token from the machine that ran cf-opencode init",
    );
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    if (body?.error) throw new CliError(body.error, "see the line above");
    throw new CliError(
      `${d.url} answered HTTP ${res.status}${res.status === 404 ? "; the Worker is older than this CLI" : ""}`,
      res.status === 404 ? "cf-opencode upgrade" : "retry",
    );
  }
  return res;
}
