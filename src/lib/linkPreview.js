/**
 * Detect platform and build a preview (thumbnail + real title) from a
 * public social/video URL. Titles are fetched via oEmbed / noembed when
 * possible so the poster never has to type them.
 */

export function detectPlatform(url) {
  const u = (url || "").toLowerCase();
  if (/youtu\.be|youtube\.com/.test(u)) return "youtube";
  if (/facebook\.com|fb\.watch|fb\.com/.test(u)) return "facebook";
  if (/instagram\.com/.test(u)) return "instagram";
  if (/twitch\.tv/.test(u)) return "twitch";
  return null;
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0];
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => p === "embed" || p === "shorts" || p === "live");
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  } catch { /* ignore */ }
  return null;
}

/** Sync fallback — thumbnail + platform label only. */
export function buildLinkPreview(url) {
  const link = (url || "").trim();
  if (!link) throw new Error("Link is required");
  const platform = detectPlatform(link);
  if (!platform) {
    throw new Error("Only YouTube, Facebook, Instagram, and Twitch links are supported");
  }

  let title = platform.charAt(0).toUpperCase() + platform.slice(1) + " post";
  let thumbnail = null;

  if (platform === "youtube") {
    const id = youtubeId(link);
    if (id) {
      thumbnail = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
      title = "YouTube video";
    }
  } else if (platform === "twitch") {
    try {
      const path = new URL(link).pathname.split("/").filter(Boolean);
      if (path[0] === "videos" && path[1]) title = `Twitch VOD ${path[1]}`;
      else if (path[0]) title = `${path[0]} on Twitch`;
    } catch { /* ignore */ }
  }

  return { platform, title, thumbnail, link };
}

/**
 * Fetch the real video/post title (and better thumbnail when available).
 * Uses noembed.com (CORS-friendly) then falls back to YouTube oEmbed /
 * the sync preview.
 */
export async function fetchLinkPreview(url) {
  const base = buildLinkPreview(url);
  const link = base.link;

  // 1) noembed — works for YouTube, and some other providers
  try {
    const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(link)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && !data.error) {
        if (data.title) base.title = data.title;
        if (data.thumbnail_url) base.thumbnail = data.thumbnail_url;
        return base;
      }
    }
  } catch { /* continue */ }

  // 2) YouTube oEmbed (may fail on CORS in some browsers)
  if (base.platform === "youtube") {
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.title) base.title = data.title;
        if (data.thumbnail_url) base.thumbnail = data.thumbnail_url;
      }
    } catch { /* keep fallback */ }
  }

  return base;
}
