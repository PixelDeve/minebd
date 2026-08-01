import { initializeApp } from "firebase/app";
import { isSupported, getAnalytics } from "firebase/analytics";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration (safe to keep in client code —
// access is controlled by Firestore/Auth rules, not by hiding this key).
const firebaseConfig = {
  apiKey: "AIzaSyBxS4In0WrN7R2hnFU3iOQ7DkJyowlF7_8",
  authDomain: "m1nebd.firebaseapp.com",
  projectId: "m1nebd",
  storageBucket: "m1nebd.firebasestorage.app",
  messagingSenderId: "151910032724",
  appId: "1:151910032724:web:54f24fe2ed7b70c55a14c1",
  measurementId: "G-9SK3NMCNYC",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);

// Analytics only works in a real browser with cookies/tracking allowed,
// so it's guarded to avoid crashing during local dev or in restrictive browsers.
export let analytics = null;
isSupported().then((ok) => {
  if (ok) analytics = getAnalytics(app);
});
