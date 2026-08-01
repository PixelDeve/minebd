/**
 * Pings a real Minecraft server via the free mcstatus.io API.
 * Docs: https://mcstatus.io/docs
 *
 * Endpoints:
 *   Java:    GET https://api.mcstatus.io/v2/status/java/<host[:port]>
 *   Bedrock: GET https://api.mcstatus.io/v2/status/bedrock/<host[:port]>
 *
 * Rate limit: 5 requests/second per client IP — we throttle batch pings
 * so a full server list refresh does not get 429'd.
 */

const JAVA_URL = "https://api.mcstatus.io/v2/status/java";
const BEDROCK_URL = "https://api.mcstatus.io/v2/status/bedrock";

/** Max concurrent status requests (under the 5/s limit, with headroom). */
const CONCURRENCY = 4;

/**
 * Build address string. If `ip` already contains a port, don't double it.
 */
function formatAddress(ip, port) {
  const host = (ip || "").trim();
  if (!host) throw new Error("Missing IP");
  // Already host:port
  if (/:\d+$/.test(host) || host.includes("]:")) return host;
  const p = (port || "").toString().trim();
  return p ? `${host}:${p}` : host;
}

/**
 * Ping a single host. `platform` is "Bedrock" or anything else (treated as Java).
 * Returns { online, players, cap } or throws on network/HTTP failure.
 * Offline servers still return a 200 with online:false — that is not an error.
 */
export async function pingServer(ip, port, platform) {
  const isBedrock = platform === "Bedrock";
  const address = formatAddress(ip, port);
  // query=false skips plugin/software lookup — faster and enough for online/players.
  const base = isBedrock ? BEDROCK_URL : JAVA_URL;
  const url = `${base}/${encodeURIComponent(address)}?query=false`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ping failed (${res.status}): ${body || res.statusText}`);
  }
  const data = await res.json();

  return {
    online: !!data.online,
    players: data.players?.online ?? 0,
    cap: data.players?.max ?? 0,
  };
}

/**
 * Resolve the hosts to ping for a server listing.
 * Supports split javaIp/bedrockIp (new) and legacy single ip/port.
 */
function hostsToPing(s) {
  const out = [];
  if (s.javaIp?.trim()) {
    out.push({ ip: s.javaIp.trim(), port: s.javaPort || "", platform: "Java" });
  }
  if (s.bedrockIp?.trim()) {
    out.push({ ip: s.bedrockIp.trim(), port: s.bedrockPort || "", platform: "Bedrock" });
  }
  if (!out.length && s.ip?.trim()) {
    out.push({
      ip: s.ip.trim(),
      port: s.port || "",
      platform: s.platform === "Bedrock" ? "Bedrock" : "Java",
    });
  }
  return out;
}

/** Run async tasks with a fixed concurrency limit. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Pings a batch of servers (rate-limited) and returns a map of id -> status.
 * When a listing has both Java and Bedrock addresses, both are pinged;
 * the server is online if either answers, and player counts prefer the
 * first online result (Java is listed first when present).
 * Failures are treated as "couldn't determine" rather than crashing the list.
 */
export async function pingServers(servers) {
  // Flatten to individual host pings so concurrency applies across the whole list.
  const jobs = [];
  for (const s of servers) {
    const targets = hostsToPing(s);
    for (const t of targets) {
      jobs.push({ serverId: s.id, ...t });
    }
  }

  const jobResults = await mapPool(jobs, CONCURRENCY, async (job) => {
    try {
      const status = await pingServer(job.ip, job.port, job.platform);
      return { serverId: job.serverId, status };
    } catch {
      return { serverId: job.serverId, status: null };
    }
  });

  // Merge per-server: online if any host is online; prefer first online players/cap.
  const byId = {};
  for (const { serverId, status } of jobResults) {
    if (!status) continue;
    const prev = byId[serverId];
    if (!prev) {
      byId[serverId] = { ...status };
      continue;
    }
    if (status.online && !prev.online) {
      byId[serverId] = { ...status };
    } else if (status.online && prev.online) {
      // Keep first online (Java preferred because it is queued first)
      byId[serverId] = {
        online: true,
        players: prev.players,
        cap: prev.cap,
      };
    } else if (!prev.online && !status.online) {
      // both offline — keep first
    }
  }

  return byId;
}
