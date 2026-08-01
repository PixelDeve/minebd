// Every shareable link uses window.location.origin, so it always matches
// wherever the site is actually deployed (Cloudflare Pages, Firebase
// Hosting, a custom domain, even localhost) instead of a hardcoded guess.

const TYPES = ["servers", "events", "resources", "developers", "players", "content"];

export function shareUrl(type, id) {
  return `${window.location.origin}/${type}/${id}`;
}

/** Copies the link, pushes it into the address bar, and returns it. */
export function copyShareLink(type, id) {
  const url = shareUrl(type, id);
  navigator.clipboard?.writeText(url);
  window.history.pushState(null, "", `/${type}/${id}`);
  return url;
}

export function resetShareUrl() {
  if (TYPES.some((t) => window.location.pathname.startsWith(`/${t}/`))) {
    window.history.pushState(null, "", "/");
  }
}

/** Reads /servers/:id, /events/:id, /resources/:id, /developers/:id, or /players/:id from the URL. */
export function getDeepLinkFromPath() {
  const m = window.location.pathname.match(/^\/(servers|events|resources|developers|players|content)\/([^/]+)\/?$/);
  return m ? { type: m[1], id: decodeURIComponent(m[2]) } : null;
}

export const TAB_FOR_SHARE_TYPE = {
  servers: "servers",
  events: "events",
  resources: "market",
  developers: "devs",
  players: "players",
  content: "creators",
};
