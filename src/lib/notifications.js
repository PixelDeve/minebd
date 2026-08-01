import { useEffect, useState } from "react";
import {
  collection, addDoc, doc, onSnapshot, updateDoc, deleteDoc,
  query, orderBy, limit, getDocs, serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";

/** Writes one notification into the recipient's own subcollection. */
export async function sendNotification(targetUid, { type, message, link }) {
  if (!targetUid) return;
  try {
    await addDoc(collection(db, "users", targetUid, "notifications"), {
      type,
      message,
      link: link || null,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[minebd] Could not send notification:", err);
  }
}

/**
 * Notifies everyone following a server/developer doc. Fine at community
 * scale — a very large follower list would want a Cloud Function fan-out
 * instead of doing this from the poster's own browser.
 */
export async function notifyFollowers(parentCollection, parentId, payload) {
  try {
    const snap = await getDocs(collection(db, parentCollection, parentId, "followers"));
    await Promise.all(snap.docs.map((d) => sendNotification(d.id, payload)));
  } catch (err) {
    console.error("[minebd] Could not notify followers:", err);
  }
}

/** Live list of the signed-in person's own notifications, newest first. */
export function useNotifications(uid) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!uid) { setItems([]); return; }
    const q = query(collection(db, "users", uid, "notifications"), orderBy("createdAt", "desc"), limit(30));
    const unsub = onSnapshot(
      q,
      (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.error("[minebd] notifications listener error:", err)
    );
    return unsub;
  }, [uid]);

  const markRead = (id) => updateDoc(doc(db, "users", uid, "notifications", id), { read: true });
  const markAllRead = () => Promise.all(items.filter((n) => !n.read).map((n) => markRead(n.id)));
  const clear = (id) => deleteDoc(doc(db, "users", uid, "notifications", id));

  return { items, unreadCount: items.filter((n) => !n.read).length, markRead, markAllRead, clear };
}
