// init --domain: the Worker on a Custom Domain, a hostname in a zone of the account.
//
// The hostname goes into the copied wrangler.jsonc as a route with custom_domain: true, and wrangler deploy makes
// the Custom Domain and its DNS record. Without a terminal, as init runs it, wrangler 4.156.0 also replaces a DNS
// record on that hostname and takes the hostname from another Worker, and asks nothing (publishCustomDomains). So
// the check here refuses both before the deploy, unless --adopt. Every probe is a read; none changes the account.
import { promises as dns } from "node:dns";
import type { CfApi, Known } from "./cloudflare-api.js";
import { CliError } from "./errors.js";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A Failed line for a value that cannot be a Custom Domain hostname, or undefined. */
export function hostnameError(host: string): CliError | undefined {
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^[0-9.]+$/.test(host))
    return new CliError(
      `--domain ${JSON.stringify(host)} is not a hostname`,
      "pass only the hostname, for example code.example.com",
    );
  if (host.endsWith(".workers.dev"))
    return new CliError(
      `--domain ${host} is a workers.dev hostname`,
      "pass a hostname in a zone of your account, or leave out --domain",
    );
  return undefined;
}

/** The names a zone of `host` can have, longest first: a.b.example.com, b.example.com, example.com. */
export function zoneCandidates(host: string): string[] {
  const labels = host.split(".");
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
}

export interface Zone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
}

export interface DomainProbe {
  /** The zone of the hostname in this account, or undefined when the account has none. */
  zone: Known<Zone | undefined>;
  /** The Worker that has the hostname as a Custom Domain now, or undefined. */
  owner: Known<string | undefined>;
  /** The types of the DNS records on the hostname. */
  records: Known<string[]>;
}

/** Query the zone's own nameservers for records on `host`. */
export type ResolveDns = (host: string, nameServers: string[]) => Promise<Known<string[]>>;

export async function probeDomain(
  host: string,
  accountId: string,
  api: CfApi | undefined,
  resolve: ResolveDns = resolveAuthoritative,
): Promise<DomainProbe> {
  if (!api) {
    const none = { kind: "unknown" as const, reason: "no Cloudflare API token from wrangler" };
    return { zone: none, owner: none, records: none };
  }
  let zone: Known<Zone | undefined> = { kind: "known", value: undefined };
  for (const name of zoneCandidates(host)) {
    const r = await api.get<{ id: string; name: string; status: string; name_servers?: string[] }[]>(
      "/zones",
      {
        name,
        "account.id": accountId,
      },
    );
    if (r.kind === "unknown") {
      zone = r;
      break;
    }
    const z = r.value[0];
    if (z) {
      zone = {
        kind: "known",
        value: { id: z.id, name: z.name, status: z.status, nameServers: z.name_servers ?? [] },
      };
      break;
    }
  }
  const domains = await api.get<{ hostname: string; service: string }[]>(
    `/accounts/${accountId}/workers/domains`,
    {
      hostname: host,
    },
  );
  const owner: Known<string | undefined> =
    domains.kind === "known"
      ? { kind: "known", value: domains.value.find((d) => d.hostname === host)?.service }
      : domains;
  let records: Known<string[]> = { kind: "unknown", reason: "no zone to read" };
  if (zone.kind === "known" && zone.value) {
    const z = zone.value;
    const r = await api.get<{ name: string; type: string }[]>(`/zones/${z.id}/dns_records`, { name: host });
    if (r.kind === "known")
      records = {
        kind: "known",
        value: [...new Set(r.value.filter((x) => x.name === host).map((x) => x.type))],
      };
    else {
      // wrangler's login has no DNS read scope. The zone's own nameservers answer without one, and without
      // a cache that would remember the name as missing after the deploy makes it.
      const ns = await resolve(host, z.nameServers);
      records = ns.kind === "known" ? ns : { kind: "unknown", reason: `${r.reason}; ${ns.reason}` };
    }
  }
  return { zone, owner, records };
}

/** Failed lines that stop the deploy, and `!` lines for facts the probe could not read. */
export function domainCheck(
  host: string,
  name: string,
  p: DomainProbe,
  adopt = false,
): { errors: CliError[]; warnings: string[]; zone?: string } {
  const errors: CliError[] = [];
  const warnings: string[] = [];
  if (p.zone.kind === "unknown")
    warnings.push(
      `! could not check the zone of ${host} (${p.zone.reason}); the deploy fails if the account has no zone for it`,
    );
  else if (!p.zone.value)
    errors.push(
      new CliError(
        `no zone for ${host} in this Cloudflare account`,
        "add the domain to this account, pass --account <id> of the account that has it, or pass another --domain",
      ),
    );
  else if (p.zone.value.status !== "active")
    errors.push(
      new CliError(
        `the zone ${p.zone.value.name} is ${p.zone.value.status}, not active`,
        "finish its setup in the Cloudflare dashboard (nameservers), then rerun",
      ),
    );
  if (p.owner.kind === "unknown")
    warnings.push(`! could not check the Custom Domains of ${host} (${p.owner.reason})`);
  else if (p.owner.value === name) return { errors, warnings, ...zoneName(p) };
  else if (p.owner.value && !adopt)
    errors.push(
      new CliError(
        `${host} is a Custom Domain of the Worker ${p.owner.value}`,
        `pass another --domain, or pass --adopt to move it to ${name}`,
      ),
    );
  if (p.records.kind === "unknown") {
    if (p.zone.kind === "known" && p.zone.value)
      warnings.push(
        `! could not read the DNS records of ${host} (${p.records.reason}); the deploy replaces a record on that name`,
      );
  } else if (p.records.value.length > 0 && !p.owner.value && !adopt)
    errors.push(
      new CliError(
        `${host} has DNS records (${p.records.value.join(", ")}), and the deploy replaces them`,
        "delete them in the Cloudflare dashboard, pass another --domain, or pass --adopt to replace them",
      ),
    );
  return { errors, warnings, ...zoneName(p) };
}

const zoneName = (p: DomainProbe) =>
  p.zone.kind === "known" && p.zone.value ? { zone: p.zone.value.name } : {};

/** Ask the zone's own nameservers for A, AAAA and CNAME records on `host`. */
export const resolveAuthoritative: ResolveDns = async (host, nameServers) => {
  const ips = (await Promise.all(nameServers.map((n) => dns.resolve4(n).catch(() => [] as string[])))).flat();
  if (ips.length === 0) return { kind: "unknown", reason: "cannot resolve the zone's nameservers" };
  const r = new dns.Resolver({ timeout: 3_000, tries: 2 });
  r.setServers(ips);
  const types: string[] = [];
  const lookups: [string, (h: string) => Promise<unknown[]>][] = [
    ["A", (h) => r.resolve4(h)],
    ["AAAA", (h) => r.resolve6(h)],
    ["CNAME", (h) => r.resolveCname(h)],
  ];
  for (const [type, lookup] of lookups) {
    try {
      if ((await lookup(host)).length > 0) types.push(type);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENODATA" && code !== "ENOTFOUND")
        return { kind: "unknown", reason: `the zone's nameservers did not answer (${code ?? "error"})` };
    }
  }
  return { kind: "known", value: types };
};
