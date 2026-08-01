import { doc, setDoc, getDocs, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Call once per session for a signed-in user. Writes one doc keyed by
 * their own uid under today's date, so repeated visits the same day don't
 * inflate the count — this tracks *unique daily active accounts*, not raw
 * page loads. Anonymous (signed-out) browsing isn't counted, which keeps
 * the write rule simple (see firestore.rules) and avoids it being trivially
 * spammable from the browser console.
 */
export async function logDailyVisit(uid) {
  if (!uid) return;
  try {
    await setDoc(doc(db, "analytics", dateKey(), "activeUsers", uid), { at: serverTimestamp() });
  } catch (err) {
    console.error("[minebd] Could not log daily visit (admin-dashboard stat only, otherwise harmless):", err);
  }
}

/** Unique-visitor counts for the last N days, oldest first — for the admin dashboard graph. */
export async function getRecentVisitCounts(days = 14) {
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    try {
      const snap = await getDocs(collection(db, "analytics", key, "activeUsers"));
      out.push({ date: key, count: snap.size });
    } catch (err) {
      out.push({ date: key, count: 0 });
    }
  }
  return out;
}
