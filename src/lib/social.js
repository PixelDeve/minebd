import {
  doc, addDoc, setDoc, deleteDoc, getDoc, getDocs, collection, updateDoc, serverTimestamp,
  runTransaction, increment,
} from "firebase/firestore";
import { db } from "../firebase";

/**
 * Every function below uses the acting user's uid as the subcollection
 * document ID (servers/{id}/reviews/{uid}, developers/{id}/ratings/{uid},
 * reports/{id}/votes/{uid}). That's what makes "one review/rating/vote per
 * account, editable" true by construction — writing again just overwrites
 * their own doc instead of creating a new one, and Firestore rules only
 * let a user write the doc whose ID matches their own uid.
 */

// ---------------------------------------------------------------------------
// Server reviews (star rating + optional comment, one per person, editable)
// ---------------------------------------------------------------------------
export async function submitServerReview(serverId, uid, name, stars, text) {
  await setDoc(doc(db, "servers", serverId, "reviews", uid), {
    uid,
    name: name || "Player",
    stars,
    text: text || "",
    updatedAt: serverTimestamp(),
  });
  await recomputeAverage("servers", serverId, "reviews");
}

export async function getMyServerReview(serverId, uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "servers", serverId, "reviews", uid));
  return snap.exists() ? snap.data() : null;
}

// ---------------------------------------------------------------------------
// Marketplace resource reviews (plugin/mod/texture/world) — identical
// shape and pattern to server reviews above.
// ---------------------------------------------------------------------------
export async function submitResourceReview(resourceId, uid, name, stars, text) {
  await setDoc(doc(db, "resources", resourceId, "reviews", uid), {
    uid,
    name: name || "Player",
    stars,
    text: text || "",
    updatedAt: serverTimestamp(),
  });
  await recomputeAverage("resources", resourceId, "reviews");
}

// ---------------------------------------------------------------------------
// Developer ratings (stars only, one per person, editable)
// ---------------------------------------------------------------------------
export async function submitDevRating(devId, uid, stars) {
  await setDoc(doc(db, "developers", devId, "ratings", uid), {
    uid,
    stars,
    updatedAt: serverTimestamp(),
  });
  await recomputeAverage("developers", devId, "ratings");
}

export async function getMyDevRating(devId, uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "developers", devId, "ratings", uid));
  return snap.exists() ? snap.data().stars : null;
}

// Shared by both of the above: recompute rating/votes from the subcollection
// and write the aggregate onto the parent doc.
async function recomputeAverage(parentCollection, parentId, subName) {
  const snap = await getDocs(collection(db, parentCollection, parentId, subName));
  const values = snap.docs.map((d) => d.data().stars).filter((n) => typeof n === "number");
  const votes = values.length;
  const rating = votes ? values.reduce((a, b) => a + b, 0) / votes : 0;
  await updateDoc(doc(db, parentCollection, parentId), { rating, votes });
}

// ---------------------------------------------------------------------------
// Best Player likes — exactly one like per account, toggled on/off. This is
// what ranks the leaderboard's 1st/2nd/3rd, so it uses the same doc-ID-is-
// uid pattern as reviews/ratings/votes above rather than a shared counter.
// ---------------------------------------------------------------------------
export async function getMyPlayerLike(playerId, uid) {
  if (!uid) return false;
  const snap = await getDoc(doc(db, "players", playerId, "likes", uid));
  return snap.exists();
}

export async function togglePlayerLike(playerId, uid) {
  const likeRef = doc(db, "players", playerId, "likes", uid);
  const playerRef = doc(db, "players", playerId);
  // Transaction instead of read-then-recount-then-write: two people (or two
  // fast clicks) toggling at once can no longer land on the wrong final
  // count, since the like's existence and the counter update happen
  // atomically together.
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(likeRef);
    const nowLiked = !existing.exists();
    if (existing.exists()) tx.delete(likeRef);
    else tx.set(likeRef, { likedAt: serverTimestamp() });
    tx.update(playerRef, { likes: increment(nowLiked ? 1 : -1) });
    return nowLiked;
  });
}

// ---------------------------------------------------------------------------
// Report up/down votes — exactly one vote per account. Clicking the same
// direction again removes the vote (toggle off); clicking the other
// direction switches it. Nobody can rack up repeat votes from one account.
// ---------------------------------------------------------------------------
export async function getMyReportVote(reportId, uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "reports", reportId, "votes", uid));
  return snap.exists() ? snap.data().dir : null;
}

export async function toggleReportVote(reportId, uid, dir) {
  const voteRef = doc(db, "reports", reportId, "votes", uid);
  const reportRef = doc(db, "reports", reportId);
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(voteRef);
    const prevDir = existing.exists() ? existing.data().dir : null;
    const deltas = { up: 0, down: 0 };
    let newDir;
    if (prevDir === dir) {
      tx.delete(voteRef); // same button again = un-vote
      newDir = null;
      deltas[dir] -= 1;
    } else {
      tx.set(voteRef, { dir, updatedAt: serverTimestamp() });
      newDir = dir;
      if (prevDir) deltas[prevDir] -= 1; // switching from the other direction
      deltas[dir] += 1;
    }
    const patch = {};
    if (deltas.up) patch.up = increment(deltas.up);
    if (deltas.down) patch.down = increment(deltas.down);
    if (Object.keys(patch).length) tx.update(reportRef, patch);
    return newDir;
  });
}

// ---------------------------------------------------------------------------
// "Report as false" flags — one per account, toggled, same doc-ID-is-uid
// pattern as votes. Lets admins see how many people think a report is bogus
// without giving any single flag the power to change/hide the report itself.
// ---------------------------------------------------------------------------
export async function getMyReportFlag(reportId, uid) {
  if (!uid) return false;
  const snap = await getDoc(doc(db, "reports", reportId, "flags", uid));
  return snap.exists();
}

export async function toggleReportFlag(reportId, uid) {
  const flagRef = doc(db, "reports", reportId, "flags", uid);
  const reportRef = doc(db, "reports", reportId);
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(flagRef);
    const nowFlagged = !existing.exists();
    if (existing.exists()) tx.delete(flagRef);
    else tx.set(flagRef, { flaggedAt: serverTimestamp() });
    tx.update(reportRef, { flagged: increment(nowFlagged ? 1 : -1) });
    return nowFlagged;
  });
}

// ---------------------------------------------------------------------------
// Follow/bookmark a server or developer — one per account, toggled. Powers
// both the bookmark button and (via each item's followers subcollection)
// who gets notified when that server posts a new event.
// ---------------------------------------------------------------------------
export async function isFollowing(parentCollection, parentId, uid) {
  if (!uid) return false;
  const snap = await getDoc(doc(db, parentCollection, parentId, "followers", uid));
  return snap.exists();
}

export async function toggleFollow(parentCollection, parentId, uid) {
  const followRef = doc(db, parentCollection, parentId, "followers", uid);
  const parentRef = doc(db, parentCollection, parentId);
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(followRef);
    const nowFollowing = !existing.exists();
    if (existing.exists()) tx.delete(followRef);
    else tx.set(followRef, { followedAt: serverTimestamp() });
    tx.update(parentRef, { followers: increment(nowFollowing ? 1 : -1) });
    return nowFollowing;
  });
}

/** All uids following a server/developer — used to fan out notifications. */
export async function getFollowerIds(parentCollection, parentId) {
  const snap = await getDocs(collection(db, parentCollection, parentId, "followers"));
  return snap.docs.map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Event RSVPs ("I'm interested") — one per account, toggled.
// ---------------------------------------------------------------------------
export async function getMyRsvp(eventId, uid) {
  if (!uid) return false;
  const snap = await getDoc(doc(db, "events", eventId, "rsvps", uid));
  return snap.exists();
}

export async function toggleRsvp(eventId, uid) {
  const rsvpRef = doc(db, "events", eventId, "rsvps", uid);
  const eventRef = doc(db, "events", eventId);
  return runTransaction(db, async (tx) => {
    const existing = await tx.get(rsvpRef);
    const nowGoing = !existing.exists();
    if (existing.exists()) tx.delete(rsvpRef);
    else tx.set(rsvpRef, { rsvpAt: serverTimestamp() });
    tx.update(eventRef, { rsvpCount: increment(nowGoing ? 1 : -1) });
    return nowGoing;
  });
}

// ---------------------------------------------------------------------------
// Server comment thread — unlike reviews, a person can post more than one
// comment, so these use auto-generated IDs rather than uid-as-ID.
// ---------------------------------------------------------------------------
export async function postComment(serverId, uid, name, text) {
  await addDoc(collection(db, "servers", serverId, "comments"), {
    uid,
    name: name || "Player",
    text,
    createdAt: serverTimestamp(),
  });
}

export async function deleteComment(serverId, commentId) {
  await deleteDoc(doc(db, "servers", serverId, "comments", commentId));
}
