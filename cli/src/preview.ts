// cf-opencode preview: open a dev server that runs in a workspace, in the local browser.
//
// Private (the default): the Worker proxies /preview/<id>/<port>/ behind the workspace password. A browser cannot
// send that password, so the CLI asks the Worker for a one-time sign-in link (POST /preview/<id>/link, with the
// password in a Basic header) and opens it. The link carries a ticket that works once, for 2 minutes; the Worker
// spends it and gives the browser a cookie for that workspace and port. The password is never in a URL.
//
// Public (--public): a URL with an unguessable token that needs no password, until --stop. Only the control token
// makes or removes one, so an agent in the workspace, which has the workspace password, cannot publish a port.
import { spawn } from "node:child_process";
import type { ControlClient, PublicPreview } from "./api.js";
import { CliError } from "./errors.js";
import type { Target } from "./terminal.js";

export interface PreviewLink {
  url: string;
  link: string;
  expiresAt: string;
  awake: boolean;
  listening: boolean;
}

/** A port the Worker accepts for a preview. OpenCode's own port and sshd are refused there too. */
export function parsePort(raw: string | undefined, id: string): number {
  if (raw === undefined) throw new CliError("preview needs a port", `cf-opencode preview ${id} <port>`);
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(port >= 1024 && port <= 65535))
    throw new CliError(`bad port ${raw}`, "pass the dev server's port, a number from 1024 to 65535");
  return port;
}

/** Ask the Worker for a one-time sign-in link. Fails with one line when the workspace is paused. */
export async function previewLink(
  t: Target,
  port: number,
  fetchFn: typeof fetch = (i, o) => fetch(i, o),
): Promise<PreviewLink> {
  let res: Response;
  try {
    res = await fetchFn(`${t.url}/preview/${encodeURIComponent(t.id)}/link`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${t.password}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ port }),
    });
  } catch (e) {
    throw new CliError(
      `cannot reach ${t.url} (${e instanceof Error ? e.message : String(e)})`,
      "cf-opencode doctor",
    );
  }
  const body = (await res.json().catch(() => undefined)) as (PreviewLink & { error?: string }) | undefined;
  if (!res.ok || !body?.link) {
    // The Worker's error is a whole Failed line already; CliError keeps it as it is.
    if (body?.error) throw new CliError(body.error, "see the line above");
    if (res.status === 404) throw new CliError("this Worker has no preview route", "run cf-opencode upgrade");
    throw new CliError(`preview returned ${res.status}`, `cf-opencode logs ${t.id}`);
  }
  // The link goes to a browser opener, which is `cmd /c start` on Windows: & | < > ^ % would run there. Take only
  // a link on this Worker's preview path, in the characters a ticket link has.
  const prefix = `${t.url.replace(/\/$/, "")}/preview/${encodeURIComponent(t.id)}/`;
  if (!body.link.startsWith(prefix) || !/^https?:\/\/[A-Za-z0-9._~:/?=-]+$/.test(body.link))
    throw new CliError("the Worker sent a sign-in link this CLI does not open", "cf-opencode upgrade");
  if (!body.awake)
    throw new CliError(
      `${t.id} is paused, and a dev server does not survive a pause`,
      `cf-opencode connect ${t.id}, start the dev server, then retry`,
    );
  return body;
}

/** Open a URL in the local browser. False when no opener ran. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export function renderPublic(id: string, rows: PublicPreview[]): string {
  if (!rows.length) return `${id} has no public preview. Private previews: cf-opencode preview ${id} <port>`;
  return [
    `Public previews of ${id} (anyone with the URL can open them):`,
    ...rows.map((r) => `  ${r.port}  ${r.url}`),
  ].join("\n");
}

export interface PreviewOptions {
  id: string;
  port?: string;
  public: boolean;
  stop: boolean;
  list: boolean;
  open: boolean;
  json: boolean;
  /** Needs only the workspace password. */
  target: () => Target;
  /** Needs the control token. */
  control: () => ControlClient;
  out: (s: string) => void;
  err: (s: string) => void;
  fetchFn?: typeof fetch;
  opener?: (url: string) => Promise<boolean>;
}

export async function preview(o: PreviewOptions): Promise<number> {
  const id = o.id;
  if ([o.public, o.stop, o.list].filter(Boolean).length > 1)
    throw new CliError("--public, --stop and --list do not go together", "pass one of them");

  if (o.list) {
    const { public: rows } = await o.control().previews(id);
    o.out(o.json ? JSON.stringify({ ok: true, workspace: id, public: rows }) : renderPublic(id, rows));
    return 0;
  }

  if (o.stop) {
    const port = o.port === undefined ? undefined : parsePort(o.port, id);
    const { removed } = await o.control().unsharePreview(id, port);
    if (o.json) o.out(JSON.stringify({ ok: true, workspace: id, removed }));
    else if (!removed.length) o.out(`${id} had no public preview${port ? ` on port ${port}` : ""}`);
    else o.out(`public preview removed: ${removed.map((p) => `${id} port ${p}`).join(", ")}`);
    return 0;
  }

  const port = parsePort(o.port, id);
  if (o.public) {
    const share = await o.control().sharePreview(id, port);
    if (o.json) o.out(JSON.stringify({ ok: true, workspace: id, ...share }));
    else {
      o.out(share.url);
      o.err(
        `! anyone with this URL can open port ${port} of ${id}, with no password, while the workspace is awake`,
      );
      o.err(`  remove it: cf-opencode preview ${id} ${port} --stop`);
    }
    return 0;
  }

  const link = await previewLink(o.target(), port, o.fetchFn);
  if (!link.listening)
    o.err(`! nothing answers on port ${port} yet; start the dev server on 0.0.0.0 (Vite: --host 0.0.0.0)`);
  if (o.json) {
    o.out(JSON.stringify({ ok: true, workspace: id, port, ...link }));
    return 0;
  }
  o.out(link.url);
  const opened = o.open && (await (o.opener ?? openInBrowser)(link.link));
  if (opened) o.err("opened in your browser; it stays signed in to this preview for 8 hours");
  else o.err(`sign-in link (one use, 2 minutes): ${link.link}`);
  return 0;
}
