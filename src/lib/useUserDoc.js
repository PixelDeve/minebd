import { useEffect, useState } from "react";
import {
  doc, onSnapshot, setDoc, updateDoc, addDoc, collection, serverTimestamp, increment,
  query, orderBy,
} from "firebase/firestore";
import { db } from "../firebase";

/**
 * Keeps a Firestore doc at users/{uid} in sync with the signed-in person.
 * On first sign-in a doc is created with role:'member'. Role/ban/verified
 * changes after that can only be written by an existing admin/owner (see
 * firestore.rules) — this hook just reads+writes, it doesn't decide who's
 * allowed to do what; Firestore rules are the real enforcement.
 *
 * `error` is surfaced (instead of failing silently) specifically because
 * the most common cause of "I can't find my user in the database" is that
 * firestore.rules was edited locally but never redeployed — the create
 * write below gets rejected, no doc is ever made, and nothing else in the
 * app can tell you why. If you see a permission-denied error here, run:
 *   firebase deploy --only firestore:rules
 */
export function useUserDoc(uid, displayName) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!uid) { setUser(null); setLoading(false); return; }
    const ref = doc(db, "users", uid);
    const unsub = onSnapshot(
      ref,
      async (snap) => {
        if (!snap.exists()) {
          // First time this person has signed in — create their profile doc.
          try {
            await setDoc(ref, {
              name: displayName || "Player",
              role: "member",
              verified: false,
              banned: false,
              createdAt: serverTimestamp(),
            });
            setError(null);
          } catch (err) {
            console.error("[minebd] Could not create your user profile. If this says permission-denied, firestore.rules likely needs to be (re)deployed with: firebase deploy --only firestore:rules", err);
            setError(err);
            setLoading(false);
          }
          return; // onSnapshot fires again once the doc exists
        }
        setUser({ id: snap.id, ...snap.data() });
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error("[minebd] users/{uid} listener error:", err);
        setError(err);
        setLoading(false);
      }
    );
    return unsub;
  }, [uid, displayName]);

  const updateName = async (name) => {
    try {
      await updateDoc(doc(db, "users", uid), { name });
    } catch (err) {
      console.error("[minebd] Could not update name:", err);
      alert("Couldn't save your name — " + (err?.message || "please try again."));
    }
  };

  return { user, loading, error, updateName };
}

/**
 * Call right after any successful post (server/event/report/resource/
 * developer/player/comment). Stamps lastPostAt so firestore.rules'
 * cooldownOk() can enforce a minimum gap between posts, and increments
 * postCount so the admin dashboard can surface "most active" members.
 */
export async function markPosted(uid) {
  if (!uid) return;
  try {
    await updateDoc(doc(db, "users", uid), {
      lastPostAt: serverTimestamp(),
      postCount: increment(1),
    });
  } catch (err) {
    console.error("[minebd] Could not update post-cooldown bookkeeping:", err);
  }
}

/**
 * Writes a real verification request to Firestore so admins can actually
 * review it (firestore.rules already had `verificationRequests` defined —
 * nothing in the app used to write to it, so requests just vanished into
 * an alert() and no admin ever saw them).
 */
export async function submitVerificationRequest(uid, name, method, contact) {
  await addDoc(collection(db, "verificationRequests"), {
    uid,
    name: name || "Player",
    method,
    contact,
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

/**
 * Live list of pending verification requests, newest first — admin/owner
 * panel only. Pass `enabled=false` for non-admins so they never open a
 * listener that firestore.rules is guaranteed to deny.
 */
export function useVerificationRequests(enabled) {
  const [requests, setRequests] = useState([]);
  useEffect(() => {
    if (!enabled) { setRequests([]); return; }
    const q = query(collection(db, "verificationRequests"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.error("[minebd] verificationRequests listener error:", err)
    );
    return unsub;
  }, [enabled]);

  const resolveRequest = (id, status) => updateDoc(doc(db, "verificationRequests", id), { status });

  return { requests, resolveRequest };
}

/** Full user list for the admin/owner panel, plus the actions they can take. */
export function useAllUsers() {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "users"),
      (snap) => setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.error("[minebd] users collection listener error:", err)
    );
    return unsub;
  }, []);

  const setRole = (uid, role) => updateDoc(doc(db, "users", uid), { role });
  const setBanned = (uid, banned) => updateDoc(doc(db, "users", uid), { banned });
  const setVerified = (uid, verified) => updateDoc(doc(db, "users", uid), { verified });
  /** Owner/admin only — enables monetization (dev mode) on a member's profile. */
  const setMonetized = (uid, monetized) => updateDoc(doc(db, "users", uid), { monetized: !!monetized });

  return { users, setRole, setBanned, setVerified, setMonetized };
}
