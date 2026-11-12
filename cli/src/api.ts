// Control-plane client. The token goes in a header, never in a URL or a log line.
import { CliError } from "./errors.js";

export interface OpView {
  opId: string;
  phase: "queued" | "running" | "succeeded" | "failed";
  progress: string[];
  error?: string;
  result?: Record<string, unknown>;
}

export interface RemoteSession {
  id: string;
  title: string;
  created: number;
  updated: number;
  model?: string;
  directory?: string;
}

export interface RemoteSessions {
  sessions: RemoteSession[];
  at?: string;
  live: boolean;
}

export class ControlClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async health(): Promise<{ ok: boolean; version: string }> {
    return this.get("/v1/health");
  }

  async submit(
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<{ opId: string; attached: boolean }> {
    return this.send("POST", `/v1/workspaces/${encodeURIComponent(workspaceId)}/ops`, body);
  }

  async op(opId: string, waitMs: number, since?: number): Promise<OpView> {
    const q = new URLSearchParams({ wait: String(waitMs) });
    if (since !== undefined) q.set("since", String(since));
    return this.get(`/v1/ops/${encodeURIComponent(opId)}?${q}`);
  }

  async installStatus(): Promise<{
    version: string;
    config: unknown;
    bindings?: { ai: boolean; browser: boolean; github?: boolean };
  }> {
    return this.get("/v1/status");
  }

  async status(workspaceId: string): Promise<unknown> {
    return this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async sessions(workspaceId: string): Promise<RemoteSessions> {
    return this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`);
  }

  async logs(workspaceId: string, lines: number): Promise<{ log: string }> {
    return this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/logs?lines=${lines}`);
  }

  /** Poll until the op finishes. Prints new progress lines through `onLine`. */
  async wait(opId: string, onLine: (line: string) => void, budgetMs = 5 * 60_000): Promise<OpView> {
    const until = Date.now() + budgetMs;
    let seen = 0;
    let last: OpView | undefined;
    while (Date.now() < until) {
      last = await this.op(opId, 20_000, seen);
      for (const line of last.progress.slice(seen)) onLine(line);
      seen = last.progress.length;
      if (last.phase === "succeeded" || last.phase === "failed") return last;
    }
    throw new CliError(`op ${opId} did not finish in time`, "cf-opencode status, then retry");
  }

  private async get<T>(path: string): Promise<T> {
    return this.send("GET", path);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new CliError(
        `cannot reach ${this.url} (${e instanceof Error ? e.message : String(e)})`,
        "check the URL with cf-opencode doctor",
      );
    }
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      if (res.ok)
        throw new CliError(`${this.url}${path} did not answer JSON`, "check the URL with cf-opencode doctor");
    }
    if (!res.ok) {
      const err = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : text;
      // A Worker error is a whole "Failed: … — fix: …" line already; CliError keeps it as it is.
      throw new CliError(err, "see the line above");
    }
    return parsed as T;
  }
}
