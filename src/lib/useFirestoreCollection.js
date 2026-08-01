import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy as fbOrderBy,
} from "firebase/firestore";
import { db } from "../firebase";

/**
 * Subscribes to a Firestore collection in realtime and returns simple
 * add / update / remove helpers. This one hook backs every section of
 * MineBD (servers, events, reports, resources, developers, ads) so each
 * section component just calls add(data) / update(id, data) / remove(id)
 * instead of talking to Firestore directly.
 */
export function useFirestoreCollection(name, orderField) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ref = collection(db, name);
    const q = orderField ? query(ref, fbOrderBy(orderField, "desc")) : ref;
    const unsub = onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error(`[minebd] ${name} listener error:`, err);
        setError(err);
        setLoading(false);
      }
    );
    return unsub;
  }, [name, orderField]);

  const add = (data) => addDoc(collection(db, name), data);
  const update = (id, data) => updateDoc(doc(db, name, id), data);
  const remove = (id) => deleteDoc(doc(db, name, id));

  return { items, add, update, remove, loading, error };
}
