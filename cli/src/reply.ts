// `cf-opencode tasks <session> --reply "<text>"`: send one more message to a handed-off session.
//
// A waiting task asked a question, or the caller wants to add an instruction. The message goes to
// OpenCode's own prompt call through the Worker's /oc proxy, with the workspace password, so the Worker
// needs nothing new. The proxy wakes a paused workspace, which is right: a reply means "go on".
import { CliError } from "./errors.js";

export const MAX_REPLY_CHARS = 20_000;

export async function replyTask(
  t: { url: string; id: string; password: string },
  session: string,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!/^ses_[A-Za-z0-9]{1,64}$/.test(session))
    throw new CliError("bad task id", "use the ses_… id cf-opencode run printed");
  const body = text.trim();
  if (!body) throw new CliError("the reply is empty", 'cf-opencode tasks <session> --reply "<text>"');
  if (body.length > MAX_REPLY_CHARS)
    throw new CliError(`the reply is over ${MAX_REPLY_CHARS} characters`, "shorten it");
  let res: Response;
  try {
    res = await fetchFn(
      `${t.url.replace(/\/$/, "")}/oc/${encodeURIComponent(t.id)}/api/session/${session}/prompt`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${t.password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: body }),
      },
    );
  } catch (e) {
    throw new CliError(
      `cannot reach the workspace (${e instanceof Error ? e.message : String(e)})`,
      "cf-opencode doctor",
    );
  }
  if (res.status === 401)
    throw new CliError(`no access to ${t.id}`, `cf-opencode connect ${t.id} --no-attach, then retry`);
  if (res.status === 404)
    throw new CliError(`no session ${session} in ${t.id}`, "cf-opencode tasks lists them");
  if (!res.ok)
    throw new CliError(`OpenCode refused the reply (HTTP ${res.status})`, `cf-opencode logs ${t.id}`);
}
