import { collection, addDoc, getDocs, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

/** Categories an ad can target. "all" means every list tab. */
export const AD_CATEGORIES = [
  "all",
  "servers",
  "events",
  "players",
  "reports",
  "market",
  "devs",
  "creators",
];

/** Higher quality = shown more often in the weighted rotation. */
const QUALITY_WEIGHT = {
  basic: 1,
  good: 2,
  great: 3,
  premium: 5,
};

/**
 * Filter ads that should appear on a given tab.
 * category on the ad may be "all" or a specific tab id.
 */
export function adsForCategory(ads, category) {
  if (!ads?.length) return [];
  return ads.filter((a) => {
    const cat = a.category || "all";
    return cat === "all" || cat === category;
  });
}

/**
 * Page-load seed: refresh reshuffles ads; same SPA navigation keeps order.
 */
const PAGE_AD_SEED = Date.now() ^ (Math.floor(Math.random() * 1e9));
function sessionSeed() {
  return PAGE_AD_SEED;
}

/** Mulberry32 PRNG from a numeric seed. */
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a weighted sequence of ads: premium appears more often than basic.
 * Order is shuffled per session (page refresh = new order).
 * Returns a list long enough to fill many slots; cycles if needed.
 */
export function weightedAdQueue(ads, slotsNeeded = 12) {
  if (!ads?.length) return [];
  const rand = rng(sessionSeed() + ads.map((a) => a.id).join("").length);
  // Expand pool by quality weight
  const pool = [];
  ads.forEach((ad) => {
    const w = QUALITY_WEIGHT[ad.quality] || QUALITY_WEIGHT.good;
    for (let i = 0; i < w; i++) pool.push(ad);
  });
  // Fisher–Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Ensure every ad appears at least once before repeats when possible
  const uniqueFirst = [...ads].sort(() => rand() - 0.5);
  const out = [];
  const used = new Set();
  uniqueFirst.forEach((ad) => {
    out.push(ad);
    used.add(ad.id);
  });
  // Fill remaining slots from weighted pool
  let i = 0;
  while (out.length < Math.max(slotsNeeded, ads.length * 2)) {
    const ad = pool[i % pool.length];
    out.push(ad);
    i++;
    if (i > pool.length * 20) break;
  }
  return out;
}

/**
 * Interleave ads into a list so they appear serially as you scroll.
 * - Always places every available ad at least once when the list is long enough
 * - Uses weighted queue so premium shows more often
 * - Page refresh reshuffles (session seed)
 * Returns { kind: 'item'|'ad', data }[]
 */
export function interleaveAds(items, ads, every = 3) {
  if (!items.length) {
    // Still surface ads serially even on empty lists
    if (!ads?.length) return [];
    return weightedAdQueue(ads, ads.length).slice(0, ads.length).map((data) => ({ kind: "ad", data }));
  }
  if (!ads?.length) return items.map((data) => ({ kind: "item", data }));

  const slotsNeeded = Math.max(ads.length, Math.ceil(items.length / every) + 1);
  const queue = weightedAdQueue(ads, slotsNeeded);
  const out = [];
  let adIdx = 0;

  items.forEach((item, i) => {
    out.push({ kind: "item", data: item });
    // Place an ad after every `every` items, and also after the first item
    // when the list is short so ads still appear.
    const place =
      (i + 1) % every === 0 ||
      (items.length < every && i === 0) ||
      // If we still have unique ads not shown and we're near the end, keep inserting
      (adIdx < ads.length && i === items.length - 1);
    if (place && queue.length) {
      out.push({ kind: "ad", data: queue[adIdx % queue.length] });
      adIdx++;
    }
  });

  // Guarantee: if we have more ads than slots filled, append remaining unique ads serially
  if (adIdx < ads.length) {
    const shown = new Set(out.filter((x) => x.kind === "ad").map((x) => x.data.id));
    ads.forEach((ad) => {
      if (!shown.has(ad.id)) {
        out.push({ kind: "ad", data: ad });
        shown.add(ad.id);
      }
    });
  }

  return out;
}

/**
 * Record that an ad was shown (on a list or on a monetized profile).
 */
export async function recordAdImpression(adId, { profileUid = null, category = null, viewerUid = null } = {}) {
  if (!adId) return;
  try {
    await addDoc(collection(db, "ads", adId, "impressions"), {
      profileUid: profileUid || null,
      category: category || null,
      viewerUid: viewerUid || null,
      at: serverTimestamp(),
    });
  } catch (err) {
    console.error("[minebd] Could not record ad impression:", err);
  }
}

/** Total impression counts per ad (owner dashboard). */
export async function getAdImpressionCounts(adIds) {
  const result = {};
  await Promise.all(
    (adIds || []).map(async (id) => {
      try {
        const snap = await getDocs(collection(db, "ads", id, "impressions"));
        result[id] = snap.size;
      } catch {
        result[id] = 0;
      }
    })
  );
  return result;
}

/**
 * Payout: fixed ৳100 per 100,000 views (as specified).
 * Display-only until real payouts are wired.
 */
export function estimatePayout(views) {
  const v = Number(views) || 0;
  return Math.floor(v / 100000) * 100;
}

/** Progress toward the next 100k payout threshold (0–100). */
export function payoutProgress(views) {
  const v = Number(views) || 0;
  return ((v % 100000) / 100000) * 100;
}
