import React, { useState, useEffect, useMemo } from "react";
import {
  Plus, Search, Star, Users, Share2, Pencil, Trash2,
  ThumbsUp, ThumbsDown, Flag, Upload, Globe, ShieldCheck, User, LogIn, LogOut,
  Calendar, Clock, Code2, Image as ImageIcon,
  Megaphone, X, ChevronRight, Server as ServerIcon, Package, Wrench, Crown,
  ShieldAlert, BadgeCheck, Ban, UserCog, Loader2, Wifi, Trophy, Heart,
  Bookmark, MessageCircle, Bell, TrendingUp, Sparkles, BarChart3, CheckCheck, Send,
  Film, ExternalLink, DollarSign, Eye
} from "lucide-react";
import { auth, googleProvider, db } from "./firebase";
import {
  signInWithPopup, signOut, onAuthStateChanged, deleteUser,
} from "firebase/auth";
import { collection, onSnapshot, doc, setDoc, getDoc, updateDoc, deleteDoc, increment } from "firebase/firestore";
import { useFirestoreCollection } from "./lib/useFirestoreCollection";
import { uploadImage, deleteImagesFromRecord, deleteReplacedImages } from "./lib/uploadcare";
import { pingServers } from "./lib/pingServer";
import { useUserDoc, useAllUsers, markPosted, submitVerificationRequest, useVerificationRequests } from "./lib/useUserDoc";
import {
  submitServerReview, submitResourceReview,
  submitDevRating, getMyDevRating,
  toggleReportVote, getMyReportVote,
  toggleReportFlag, getMyReportFlag,
  togglePlayerLike, getMyPlayerLike,
  isFollowing, toggleFollow, getFollowerIds,
  getMyRsvp, toggleRsvp,
  postComment, deleteComment,
} from "./lib/social";
import { copyShareLink, resetShareUrl, getDeepLinkFromPath, TAB_FOR_SHARE_TYPE } from "./lib/share";
import { notifyFollowers, sendNotification, useNotifications } from "./lib/notifications";
import { logDailyVisit, getRecentVisitCounts } from "./lib/analytics";
import { buildLinkPreview, fetchLinkPreview, detectPlatform } from "./lib/linkPreview";
import { adsForCategory, interleaveAds, recordAdImpression, getAdImpressionCounts, estimatePayout, payoutProgress, AD_CATEGORIES } from "./lib/ads";

/* =========================================================================
   MINEBD — Bangladeshi Minecraft Community Hub
   Dark, mobile-first UI. Real Firebase Auth (Google) + Firestore (realtime)
   + Uploadcare for compressed image hosting.
   ========================================================================= */

// ---------------------------------------------------------------------------
// Dark theme tokens — restrained, not "cyberpunk". One accent per purpose.
// ---------------------------------------------------------------------------
const C = {
  bg: "#0E1113",       // page background
  panel: "#171B1E",    // cards / header
  panel2: "#1D2225",   // inputs, nested surfaces
  border: "#2A2F33",
  text: "#E7EAEC",
  muted: "#8F979D",
  green: "#1FAE73",     // primary accent (Bangladesh green, brightened for dark bg)
  greenDeep: "#123D2C",
  red: "#FF5C67",       // secondary accent (Bangladesh red, softened)
  redDeep: "#3A1418",
  gold: "#F0B94D",
};

const HOUR = 3600 * 1000;
const WEEK = 7 * 24 * HOUR;

/** Gate any post/vote/review action behind login + not-banned. */
function guardPost(session, action) {
  if (!session.loggedIn) { alert("Sign in with Google to post, vote or review."); return; }
  if (session.banned) { alert("Your account has been banned and can't post, vote, or review."); return; }
  action();
}

/** Require an explicit confirmation before a destructive action runs. */
function confirmed(message, action) {
  if (window.confirm(message)) action();
}

/** True if createdAt (Date.now()-style ms, or a Firestore Timestamp) is within the last N days. */
function isRecent(createdAt, days = 7) {
  if (!createdAt) return false;
  const ms = typeof createdAt === "number" ? createdAt : createdAt.toMillis?.() ?? 0;
  return Date.now() - ms < days * 24 * HOUR;
}

/** Normalize legacy single ip/port into java/bedrock fields for display & editing. */
function serverHosts(s) {
  if (!s) return { javaIp: "", javaPort: "", bedrockIp: "", bedrockPort: "", extraHosts: [] };
  const hasSplit = !!(s.javaIp || s.bedrockIp);
  let javaIp = s.javaIp || "";
  let javaPort = s.javaPort || "";
  let bedrockIp = s.bedrockIp || "";
  let bedrockPort = s.bedrockPort || "";
  if (!hasSplit && s.ip) {
    const plat = (s.platform || "").toLowerCase();
    if (plat.includes("bedrock") && !plat.includes("java")) {
      bedrockIp = s.ip; bedrockPort = s.port || "";
    } else {
      javaIp = s.ip; javaPort = s.port || "";
    }
  }
  const extraHosts = Array.isArray(s.extraHosts)
    ? s.extraHosts.filter((h) => h && (h.ip || "").trim())
    : [];
  return { javaIp, javaPort, bedrockIp, bedrockPort, extraHosts };
}

/** Primary host used for list card + Firestore `ip` field (compat). */
function primaryHost(s) {
  const h = serverHosts(s);
  if (h.javaIp) return { ip: h.javaIp, port: h.javaPort || "", kind: "java" };
  if (h.bedrockIp) return { ip: h.bedrockIp, port: h.bedrockPort || "", kind: "bedrock" };
  return { ip: s?.ip || "", port: s?.port || "", kind: "java" };
}

/** Derive platform label from filled hosts (or keep existing). */
function derivePlatform(f) {
  const hasJ = !!(f.javaIp || "").trim();
  const hasB = !!(f.bedrockIp || "").trim();
  if (hasJ && hasB) return "Java & Bedrock";
  if (hasB) return "Bedrock";
  if (hasJ) return "Java";
  return f.platform || "Java";
}

/** Links array with legacy single `link` folded in. */
function serverLinks(s) {
  const list = [];
  if (Array.isArray(s?.links)) {
    s.links.forEach((u) => { if (typeof u === "string" && u.trim()) list.push(u.trim()); });
  }
  if (s?.link && typeof s.link === "string" && s.link.trim() && !list.includes(s.link.trim())) {
    list.unshift(s.link.trim());
  }
  return list;
}

/**
 * Briefly highlights the item a shared link pointed at (these sections are
 * flat lists with no separate detail modal, unlike servers). Clears itself
 * after a few seconds and reports back so the parent can drop the deep link.
 */
function useFlashHighlight(targetId, itemsLoaded, onConsumed) {
  const [flashId, setFlashId] = useState(null);
  useEffect(() => {
    if (!targetId || !itemsLoaded) return;
    setFlashId(targetId);
    const timer = setTimeout(() => setFlashId(null), 4000);
    onConsumed();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, itemsLoaded]);
  return flashId;
}

// ---------------------------------------------------------------------------
// i18n — English / বাংলা
// ---------------------------------------------------------------------------
const LANG = {
  en: {
    brand: "MineBD", tagline: "Community hub for Bangladeshi Minecraft players",
    made_by: "Made by PixelHive",
    support: "Support",
    about_blurb: "MineBD is a free portal for Bangladeshi Minecraft players — server list, events, reports, marketplace, hire developers, content creators, and Best Player leaderboard.",
    welcome_title: "Welcome to MineBD",
    view_full_profile: "View profile",
    contact_info: "Contact",
    about_dev: "About",
    skills_type: "Specialty",
    open_profile: "Open profile",
    nav_servers: "Servers", nav_events: "Events", nav_reports: "Reports",
    nav_market: "Market", nav_devs: "Hire Dev", nav_profile: "Profile",
    login: "Sign in with Google", logout: "Sign out", search_ph: "Search…",
    add_server: "Add server", add_event: "Add event", add_report: "New report",
    add_resource: "Upload", add_dev: "Apply as developer",
    online: "Online", offline: "Offline", players: "players", visit: "Visit link",
    share: "Share", edit: "Edit", delete: "Delete", save: "Save", cancel: "Cancel",
    reviews: "Reviews", write_review: "Write a review", submit: "Submit",
    server_name: "Server name", ip_port: "IP : Port", platform: "Platform",
    version: "Version", server_type: "Server type", description: "Description",
    links: "Links (Discord / Facebook / Website)", banner: "Banner image (optional)",
    profile_pic: "Profile picture (optional)",
    java_ip: "Java IP", bedrock_ip: "Bedrock IP", port_label: "Port",
    extra_hosts: "Other IPs (shown only in server details)",
    extra_host_label: "Label (optional)", add_extra_host: "Add another IP",
    add_link: "Add another link", links_note: "Discord, Facebook, website, store…",
    ip_required_note: "At least one of Java or Bedrock IP is required. Extra IPs only appear inside the server page.",
    auto_delete_note: "Servers offline for 7 straight weeks are removed automatically.",
    event_title: "Event title", event_server: "Hosting server",
    event_duration: "Duration (max 48 hours)", expired: "Expired", time_left: "left",
    report_player: "Report a player", report_server: "Report a server",
    gamertag: "Gamertag", report_type: "Type", proof: "Proof screenshot (optional)",
    flag_false: "Report as false", resource_name: "Name", resource_type: "Type",
    download: "Download", free: "Free", paid: "Paid", price: "Price (৳)",
    dev_name: "Name", dev_type: "Work type", dev_cv: "Description / CV",
    dev_contact: "Contact (email / phone / link)", dev_payment: "Payment",
    apply_verification: "Apply for verification — ৳150/month",
    verification_note: "Give us a contact number so admins can reach you and confirm your identity.",
    profile_name: "Display name", delete_account: "Delete account",
    role: "Role (demo switch)", admin_panel: "Admin tools", owner_panel: "Owner tools",
    ban_account: "Ban account", make_admin: "Make admin", remove_admin: "Remove admin",
    grant_verification: "Grant verification", create_ad: "Create ad",
    ad_link: "Destination link (optional)", ad_days: "Runs for (days)",
    ad_reach: "Max reach (blank = unlimited)", ad_photo: "Ad image (must)",
    sponsored: "Sponsored", login_required: "Sign in with Google to post, vote or review.",
    close: "Close", link_copied: "Share link copied!", all: "All",
    no_results: "Nothing here yet.", uploading: "Uploading…", rating: "Rating",
    nav_players: "Best Player", add_player: "Nominate player",
    player_name: "Player name / IGN", player_desc: "Why they're the best (optional)",
    player_server: "Server (optional)", player_discord: "Discord (optional)",
    none_option: "— None —", player_details: "Player details",
    likes: "likes", like: "Like",
    follow: "Follow", following: "Following", followers: "followers",
    comments: "Comments", write_comment: "Write a comment…", post: "Post",
    no_comments: "No comments yet — be the first.",
    interested: "interested", im_interested: "I'm interested",
    notifications: "Notifications", mark_all_read: "Mark all read",
    no_notifications: "No notifications yet.",
    new_badge: "New", trending_badge: "Trending",
    version_filter: "Version", uptime: "Uptime (last 14 days)",
    dashboard: "Dashboard", daily_active: "Daily active users",
    most_active: "Most active members", total_listings: "Total listings",
    view_profile: "View profile", member_since: "Member since",
    posts_by: "Posts by this member",
    nav_creators: "Creators", add_content: "Post content",
    content_link: "Video / post link", content_title: "Title (optional)",
    content_platform: "Platform", open_link: "Open",
    language: "Language",
    ad_category: "Show on", ad_category_all: "All categories",
    delete_ad: "Delete ad", active_ads: "Active ads",
    monetize: "Enable monetization", unmonetize: "Disable monetization",
    monetized: "Monetized", monetization_dev: "Monetization is in development mode",
    ad_impressions: "Ad impressions", estimated_payout: "Est. payout @100k views",
    contact_method: "Contact method", contact_value: "Contact (email / Discord / phone)",
    most_followers: "Most followed creators",
    monetization: "Monetization",
    monetization_off: "Not enabled yet — the owner must turn this on for your account.",
    monetization_on: "Monetization is enabled on your account.",
    your_views: "Your content views",
    your_earnings: "Estimated earnings",
    payout_rate: "Rate: ৳100 per 100,000 views",
    toward_next: "Toward next payout",
    content_title_auto: "Title is loaded from the video automatically",
  },
  bn: {
    brand: "মাইনবিডি", tagline: "বাংলাদেশি মাইনক্রাফট খেলোয়াড়দের কমিউনিটি হাব",
    made_by: "তৈরি করেছে PixelHive",
    support: "সাপোর্ট",
    about_blurb: "মাইনবিডি বাংলাদেশি মাইনক্রাফট খেলোয়াড়দের জন্য একটি ফ্রি পোর্টাল — সার্ভার তালিকা, ইভেন্ট, রিপোর্ট, মার্কেটপ্লেস, ডেভেলপার নিয়োগ, কন্টেন্ট ক্রিয়েটর ও সেরা খেলোয়াড় লিডারবোর্ড।",
    welcome_title: "মাইনবিডি-তে স্বাগতম",
    view_full_profile: "প্রোফাইল দেখুন",
    contact_info: "যোগাযোগ",
    about_dev: "সম্পর্কে",
    skills_type: "বিশেষত্ব",
    open_profile: "প্রোফাইল খুলুন",
    nav_servers: "সার্ভার", nav_events: "ইভেন্ট", nav_reports: "রিপোর্ট",
    nav_market: "মার্কেট", nav_devs: "ডেভেলপার", nav_profile: "প্রোফাইল",
    login: "গুগল দিয়ে লগইন", logout: "সাইন আউট", search_ph: "খুঁজুন…",
    add_server: "সার্ভার যোগ করুন", add_event: "ইভেন্ট যোগ করুন", add_report: "নতুন রিপোর্ট",
    add_resource: "আপলোড করুন", add_dev: "ডেভেলপার হিসেবে আবেদন",
    online: "অনলাইন", offline: "অফলাইন", players: "প্লেয়ার", visit: "লিংক দেখুন",
    share: "শেয়ার", edit: "সম্পাদনা", delete: "মুছুন", save: "সংরক্ষণ", cancel: "বাতিল",
    reviews: "রিভিউ", write_review: "রিভিউ লিখুন", submit: "জমা দিন",
    server_name: "সার্ভারের নাম", ip_port: "আইপি : পোর্ট", platform: "প্ল্যাটফর্ম",
    version: "ভার্সন", server_type: "সার্ভার টাইপ", description: "বিবরণ",
    links: "লিংক (ডিসকর্ড / ফেসবুক / ওয়েবসাইট)", banner: "ব্যানার ছবি (ঐচ্ছিক)",
    profile_pic: "প্রোফাইল ছবি (ঐচ্ছিক)",
    java_ip: "জাভা আইপি", bedrock_ip: "বেডরক আইপি", port_label: "পোর্ট",
    extra_hosts: "অন্যান্য আইপি (শুধু সার্ভার ডিটেইলে দেখাবে)",
    extra_host_label: "লেবেল (ঐচ্ছিক)", add_extra_host: "আরেকটি আইপি যোগ",
    add_link: "আরেকটি লিংক যোগ", links_note: "ডিসকর্ড, ফেসবুক, ওয়েবসাইট, স্টোর…",
    ip_required_note: "জাভা বা বেডরক — অন্তত একটি আইপি দিতে হবে। অতিরিক্ত আইপি শুধু সার্ভার পেজের ভিতরে দেখা যায়।",
    auto_delete_note: "টানা ৭ সপ্তাহ অফলাইন থাকলে সার্ভার স্বয়ংক্রিয়ভাবে মুছে যাবে।",
    event_title: "ইভেন্টের শিরোনাম", event_server: "হোস্টিং সার্ভার",
    event_duration: "সময়কাল (সর্বোচ্চ ৪৮ ঘণ্টা)", expired: "শেষ হয়ে গেছে", time_left: "বাকি",
    report_player: "প্লেয়ার রিপোর্ট করুন", report_server: "সার্ভার রিপোর্ট করুন",
    gamertag: "গেমারট্যাগ", report_type: "ধরন", proof: "প্রমাণ স্ক্রিনশট (ঐচ্ছিক)",
    flag_false: "মিথ্যা দাবি হিসেবে রিপোর্ট", resource_name: "নাম", resource_type: "ধরন",
    download: "ডাউনলোড", free: "ফ্রি", paid: "পেইড", price: "মূল্য (৳)",
    dev_name: "নাম", dev_type: "কাজের ধরন", dev_cv: "বিবরণ / সিভি",
    dev_contact: "যোগাযোগ (ইমেইল / ফোন / লিংক)", dev_payment: "পেমেন্ট",
    apply_verification: "ভেরিফিকেশনের জন্য আবেদন — ৳১৫০/মাস",
    verification_note: "আপনার যোগাযোগের নাম্বার দিন যাতে এডমিনরা যোগাযোগ করে পরিচয় নিশ্চিত করতে পারে।",
    profile_name: "প্রদর্শনী নাম", delete_account: "একাউন্ট মুছুন",
    role: "রোল (ডেমো সুইচ)", admin_panel: "এডমিন টুলস", owner_panel: "মালিক টুলস",
    ban_account: "একাউন্ট ব্যান করুন", make_admin: "এডমিন বানান", remove_admin: "এডমিন সরান",
    grant_verification: "ভেরিফিকেশন দিন", create_ad: "বিজ্ঞাপন তৈরি করুন",
    ad_link: "গন্তব্য লিংক (ঐচ্ছিক)", ad_days: "কতদিন চলবে (দিন)",
    ad_reach: "সর্বোচ্চ রিচ (ফাঁকা = সীমাহীন)", ad_photo: "বিজ্ঞাপনের ছবি (আবশ্যক)",
    sponsored: "স্পন্সরড", login_required: "পোস্ট, ভোট বা রিভিউ দিতে গুগল দিয়ে লগইন করুন।",
    close: "বন্ধ করুন", link_copied: "শেয়ার লিংক কপি হয়েছে!", all: "সব",
    no_results: "এখানে এখনো কিছু নেই।", uploading: "আপলোড হচ্ছে…", rating: "রেটিং",
    nav_players: "সেরা খেলোয়াড়", add_player: "খেলোয়াড় মনোনয়ন করুন",
    player_name: "খেলোয়াড়ের নাম / আইজিএন", player_desc: "কেন সেরা (ঐচ্ছিক)",
    player_server: "সার্ভার (ঐচ্ছিক)", player_discord: "ডিসকর্ড (ঐচ্ছিক)",
    none_option: "— কোনোটি না —", player_details: "খেলোয়াড়ের বিবরণ",
    likes: "লাইক", like: "লাইক",
    follow: "ফলো", following: "ফলো করছেন", followers: "ফলোয়ার",
    comments: "মন্তব্য", write_comment: "মন্তব্য লিখুন…", post: "পোস্ট",
    no_comments: "এখনো কোনো মন্তব্য নেই — প্রথম হোন।",
    interested: "আগ্রহী", im_interested: "আমি আগ্রহী",
    notifications: "নোটিফিকেশন", mark_all_read: "সব পঠিত হিসেবে চিহ্নিত করুন",
    no_notifications: "এখনো কোনো নোটিফিকেশন নেই।",
    new_badge: "নতুন", trending_badge: "ট্রেন্ডিং",
    version_filter: "ভার্সন", uptime: "আপটাইম (গত ১৪ দিন)",
    dashboard: "ড্যাশবোর্ড", daily_active: "দৈনিক সক্রিয় ব্যবহারকারী",
    most_active: "সবচেয়ে সক্রিয় সদস্য", total_listings: "মোট লিস্টিং",
    view_profile: "প্রোফাইল দেখুন", member_since: "সদস্য হয়েছেন",
    posts_by: "এই সদস্যের পোস্ট",
    nav_creators: "ক্রিয়েটর", add_content: "কন্টেন্ট পোস্ট",
    content_link: "ভিডিও / পোস্ট লিংক", content_title: "শিরোনাম (ঐচ্ছিক)",
    content_platform: "প্ল্যাটফর্ম", open_link: "খুলুন",
    language: "ভাষা",
    ad_category: "যেখানে দেখাবে", ad_category_all: "সব ক্যাটাগরি",
    delete_ad: "বিজ্ঞাপন মুছুন", active_ads: "সক্রিয় বিজ্ঞাপন",
    monetize: "মনিটাইজেশন চালু", unmonetize: "মনিটাইজেশন বন্ধ",
    monetized: "মনিটাইজড", monetization_dev: "মনিটাইজেশন ডেভেলপমেন্ট মোডে আছে",
    ad_impressions: "বিজ্ঞাপন ইম্প্রেশন", estimated_payout: "আনুমানিক পেআউট @১০০কি ভিউ",
    contact_method: "যোগাযোগের মাধ্যম", contact_value: "যোগাযোগ (ইমেইল / ডিসকর্ড / ফোন)",
    most_followers: "সবচেয়ে বেশি ফলো করা ক্রিয়েটর",
    monetization: "মনিটাইজেশন",
    monetization_off: "এখনো চালু হয়নি — মালিককে আপনার একাউন্টে চালু করতে হবে।",
    monetization_on: "আপনার একাউন্টে মনিটাইজেশন চালু আছে।",
    your_views: "আপনার কন্টেন্ট ভিউ",
    your_earnings: "আনুমানিক আয়",
    payout_rate: "হার: প্রতি ১০০,০০০ ভিউতে ৳১০০",
    toward_next: "পরবর্তী পেআউটের দিকে",
    content_title_auto: "শিরোনাম ভিডিও থেকে স্বয়ংক্রিয়ভাবে লোড হয়",
  },
};

// ---------------------------------------------------------------------------
// Client-side image compression — resizes + re-encodes as JPEG *before* it
// ever reaches Uploadcare, so uploads stay small regardless of source size.
// ---------------------------------------------------------------------------
function compressImage(file, maxDim = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Shared UI atoms
// ---------------------------------------------------------------------------
function Stars({ value, size = 14 }) {
  const full = Math.round(value || 0);
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} fill={i <= full ? C.gold : "none"} color={i <= full ? C.gold : C.border} />
      ))}
    </span>
  );
}
function VerifiedTick({ show }) { return show ? <BadgeCheck size={15} color={C.green} className="inline -mt-0.5" /> : null; }

/** Small "New" (recently created) or "Trending" (well-rated with real vote volume) pill, used on servers/resources/players. */
function ListingBadges({ t, createdAt, rating, votes, trendMinVotes = 5, trendMinRating = 4.5 }) {
  const isNew = isRecent(createdAt, 7);
  const isTrending = (votes || 0) >= trendMinVotes && (rating || 0) >= trendMinRating;
  if (!isNew && !isTrending) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {isTrending && <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: "#3A2410", color: C.gold }}><TrendingUp size={10} /> {t("trending_badge")}</span>}
      {isNew && <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: C.greenDeep, color: C.green }}><Sparkles size={10} /> {t("new_badge")}</span>}
    </span>
  );
}
function StatusDot({ online }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: online ? C.green : C.red }}>
      <span className="relative flex h-2 w-2">
        {online && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50" style={{ background: C.green }} />}
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: online ? C.green : C.red }} />
      </span>
    </span>
  );
}
function Pill({ children, active, onClick }) {
  return (
    <button onClick={onClick} className="px-3 py-1.5 rounded-full text-xs font-medium border transition whitespace-nowrap"
      style={active ? { background: C.green, color: "#08130E", borderColor: C.green } : { background: "transparent", color: C.text, borderColor: C.border }}>
      {children}
    </button>
  );
}
function SectionHeader({ icon: Icon, title, action }) {
  return (
    <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
      <div className="flex items-center gap-2">
        <Icon size={19} color={C.green} />
        <h2 className="text-base sm:text-lg font-semibold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{title}</h2>
      </div>
      {action}
    </div>
  );
}
const inputCls = "w-full px-3 py-2 rounded-lg border text-sm outline-none";
const inputStyle = { background: C.panel2, borderColor: C.border, color: C.text };

function Field({ label, children }) {
  return <div className="mb-3"><span className="text-xs font-medium mb-1 block" style={{ color: C.muted }}>{label}</span>{children}</div>;
}
function PrimaryButton({ children, onClick, icon: Icon, full, type = "button", disabled }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 rounded-lg text-sm font-medium transition ${full ? "w-full" : ""} ${disabled ? "opacity-60" : ""}`}
      style={{ background: C.green, color: "#08130E" }}>
      {Icon && <Icon size={16} />} {children}
    </button>
  );
}
function GhostButton({ children, onClick, icon: Icon }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border"
      style={{ borderColor: C.border, color: C.text }}>
      {Icon && <Icon size={14} />} {children}
    </button>
  );
}
/** Self-managed saving/disabled state so a modal can't be double-submitted by an eager tap. */
function SaveButton({ canSave, onSave, children }) {
  const [saving, setSaving] = useState(false);
  return (
    <PrimaryButton full disabled={saving || !canSave} onClick={async () => {
      if (saving || !canSave) return;
      setSaving(true);
      try { await onSave(); } catch (err) { console.error(err); alert("Couldn't save — " + (err?.message || "please try again.")); }
      finally { setSaving(false); }
    }}>
      {saving ? "…" : children}
    </PrimaryButton>
  );
}
function ImagePicker({ value, onChange }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <div className="w-16 h-16 rounded-lg overflow-hidden border flex items-center justify-center shrink-0" style={{ borderColor: C.border, background: C.panel2 }}>
        {busy ? <Loader2 size={18} className="animate-spin" color={C.muted} /> : value ? <img src={value} alt="" className="w-full h-full object-cover" /> : <ImageIcon size={20} color={C.muted} />}
      </div>
      <div className="flex-1">
        <input type="file" accept="image/*" className="text-xs w-full" style={{ color: C.muted }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              const blob = await compressImage(file);
              const url = await uploadImage(blob, file.name);
              onChange(url);
            } catch (err) {
              console.error(err);
              alert("Upload failed — check your connection and try again.");
            } finally {
              setBusy(false);
            }
          }} />
      </div>
    </div>
  );
}
function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/70 p-0 sm:p-3 overflow-y-auto" onClick={onClose}>
      <div className={`w-full ${wide ? "sm:max-w-2xl" : "sm:max-w-lg"} min-h-full sm:min-h-0 sm:rounded-2xl shadow-xl`}
        style={{ background: C.panel }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b sticky top-0" style={{ borderColor: C.border, background: C.panel }}>
          <h3 className="font-semibold" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-full" style={{ background: C.panel2 }}><X size={18} /></button>
        </div>
        <div className="p-4 sm:p-5">{children}</div>
      </div>
    </div>
  );
}
function AdSlot({ ad, t, category, profileUid, viewerUid }) {
  // Fire once when the slot mounts — tracks list/profile reach for owner analytics.
  // The guard lives *inside* the effect (not as an early return before it) so
  // this hook always runs in the same order across renders, even if `ad`
  // is null on some renders and populated on others.
  useEffect(() => {
    if (!ad) return;
    recordAdImpression(ad.id, { category: category || null, profileUid: profileUid || null, viewerUid: viewerUid || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad?.id]);
  if (!ad) return null;
  return (
    <a href={ad.link || undefined} onClick={(e) => { if (!ad.link) e.preventDefault(); }} target="_blank" rel="noreferrer"
      className="block rounded-xl overflow-hidden border relative" style={{ borderColor: C.border }}>
      <span className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: C.red, color: "#1A0507" }}>{t("sponsored")}</span>
      <div className="h-28 w-full flex items-center justify-center" style={{ background: C.panel2 }}>
        {ad.img ? <img src={ad.img} className="w-full h-full object-cover" alt="ad" /> : <Megaphone size={26} color={C.muted} />}
      </div>
    </a>
  );
}

// =============================================================================
// SERVERS
// =============================================================================
function ServerCard({ s, t, onOpen }) {
  const hosts = serverHosts(s);
  const lines = [];
  if (hosts.javaIp) lines.push({ label: "Java", text: hosts.javaPort ? `${hosts.javaIp}:${hosts.javaPort}` : hosts.javaIp });
  if (hosts.bedrockIp) lines.push({ label: "Bedrock", text: hosts.bedrockPort ? `${hosts.bedrockIp}:${hosts.bedrockPort}` : hosts.bedrockIp });
  if (!lines.length) {
    const p = primaryHost(s);
    if (p.ip) lines.push({ label: "", text: p.port ? `${p.ip}:${p.port}` : p.ip });
  }
  return (
    <div className="rounded-xl border overflow-hidden cursor-pointer active:opacity-90 transition" style={{ borderColor: C.border, background: C.panel }} onClick={() => onOpen(s)}>
      <div className="h-20 w-full" style={{ background: s.banner ? `url(${s.banner}) center/cover` : `linear-gradient(135deg, ${C.greenDeep}, #0A2119)` }} />
      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="w-10 h-10 rounded-lg -mt-8 border-2 shrink-0 overflow-hidden shadow" style={{ borderColor: C.panel, background: C.panel2 }}>
            {s.avatar ? <img src={s.avatar} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><ServerIcon size={16} color={C.muted} /></div>}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">{s.name}</p>
            {lines.map((ln, i) => (
              <p key={i} className="text-[11px] truncate" style={{ fontFamily: "'JetBrains Mono', monospace", color: C.muted }}>
                {ln.label ? <span style={{ color: C.border }}>{ln.label} </span> : null}{ln.text}
              </p>
            ))}
          </div>
          <StatusDot online={s.online} />
        </div>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: C.panel2, color: C.muted }}>{s.type}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: C.panel2, color: C.muted }}>{s.platform}</span>
          <ListingBadges t={t} createdAt={s.createdAt} rating={s.rating} votes={s.votes} />
        </div>
        <div className="flex items-center justify-between mt-2">
          <Stars value={s.rating} />
          <span className="text-[11px] flex items-center gap-1" style={{ color: C.muted }}><Users size={12} />{s.players || 0}/{s.cap || 100}</span>
        </div>
      </div>
    </div>
  );
}
function ServerFormModal({ t, initial, onClose, onSave }) {
  const hosts0 = serverHosts(initial);
  const links0 = serverLinks(initial);
  const [f, setF] = useState({
    name: initial?.name || "",
    javaIp: hosts0.javaIp,
    javaPort: hosts0.javaPort,
    bedrockIp: hosts0.bedrockIp,
    bedrockPort: hosts0.bedrockPort,
    extraHosts: hosts0.extraHosts.length ? hosts0.extraHosts.map((h) => ({ label: h.label || "", ip: h.ip || "", port: h.port || "" })) : [],
    platform: initial?.platform || "Java",
    version: initial?.version || "",
    type: initial?.type || "Survival",
    links: links0.length ? links0 : [""],
    desc: initial?.desc || "",
    banner: initial?.banner || null,
    avatar: initial?.avatar || null,
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setExtra = (i, k, v) => setF((p) => {
    const extraHosts = p.extraHosts.map((h, idx) => (idx === i ? { ...h, [k]: v } : h));
    return { ...p, extraHosts };
  });
  const setLink = (i, v) => setF((p) => {
    const links = p.links.map((u, idx) => (idx === i ? v : u));
    return { ...p, links };
  });
  const hasIp = !!(f.javaIp.trim() || f.bedrockIp.trim());

  const buildPayload = () => {
    const javaIp = f.javaIp.trim();
    const bedrockIp = f.bedrockIp.trim();
    const extraHosts = f.extraHosts
      .map((h) => ({ label: (h.label || "").trim(), ip: (h.ip || "").trim(), port: (h.port || "").trim() }))
      .filter((h) => h.ip);
    const links = f.links.map((u) => (u || "").trim()).filter(Boolean);
    const platform = derivePlatform(f);
    // Keep legacy ip/port as primary for rules + older clients
    const primary = javaIp
      ? { ip: javaIp, port: (f.javaPort || "").trim() }
      : { ip: bedrockIp, port: (f.bedrockPort || "").trim() };
    return {
      name: f.name.trim(),
      javaIp,
      javaPort: (f.javaPort || "").trim(),
      bedrockIp,
      bedrockPort: (f.bedrockPort || "").trim(),
      extraHosts,
      ip: primary.ip,
      port: primary.port,
      platform,
      version: f.version,
      type: f.type,
      links,
      link: links[0] || "",
      desc: f.desc,
      banner: f.banner,
      avatar: f.avatar,
    };
  };

  return (
    <Modal title={initial ? `${t("edit")} — ${t("nav_servers")}` : t("add_server")} onClose={onClose} wide>
      <Field label={t("server_name") + " *"}><input className={inputCls} style={inputStyle} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>

      <p className="text-[11px] mb-2" style={{ color: C.muted }}>{t("ip_required_note")}</p>
      <div className="grid sm:grid-cols-2 gap-x-4 mb-1">
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("java_ip")}>
            <input className={inputCls} style={inputStyle} placeholder="play.example.net" value={f.javaIp} onChange={(e) => set("javaIp", e.target.value)} />
          </Field>
          <Field label={t("port_label")}>
            <input className={inputCls} style={inputStyle} placeholder="25565" value={f.javaPort} onChange={(e) => set("javaPort", e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("bedrock_ip")}>
            <input className={inputCls} style={inputStyle} placeholder="play.example.net" value={f.bedrockIp} onChange={(e) => set("bedrockIp", e.target.value)} />
          </Field>
          <Field label={t("port_label")}>
            <input className={inputCls} style={inputStyle} placeholder="19132" value={f.bedrockPort} onChange={(e) => set("bedrockPort", e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="mb-3">
        <p className="text-xs font-medium mb-1" style={{ color: C.muted }}>{t("extra_hosts")}</p>
        {f.extraHosts.map((h, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 mb-2 items-end">
            <div className="col-span-3">
              <input className={inputCls} style={inputStyle} placeholder={t("extra_host_label")} value={h.label} onChange={(e) => setExtra(i, "label", e.target.value)} />
            </div>
            <div className="col-span-5">
              <input className={inputCls} style={inputStyle} placeholder="IP / host" value={h.ip} onChange={(e) => setExtra(i, "ip", e.target.value)} />
            </div>
            <div className="col-span-3">
              <input className={inputCls} style={inputStyle} placeholder={t("port_label")} value={h.port} onChange={(e) => setExtra(i, "port", e.target.value)} />
            </div>
            <div className="col-span-1 flex justify-end pb-2">
              <button type="button" onClick={() => setF((p) => ({ ...p, extraHosts: p.extraHosts.filter((_, idx) => idx !== i) }))} aria-label="Remove">
                <X size={16} color={C.muted} />
              </button>
            </div>
          </div>
        ))}
        <button type="button" onClick={() => setF((p) => ({ ...p, extraHosts: [...p.extraHosts, { label: "", ip: "", port: "" }] }))}
          className="text-xs font-medium" style={{ color: C.green }}>+ {t("add_extra_host")}</button>
      </div>

      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label={t("platform")}>
          <select className={inputCls} style={inputStyle} value={derivePlatform(f)} onChange={(e) => set("platform", e.target.value)}>
            <option>Java</option><option>Bedrock</option><option>Java & Bedrock</option>
          </select>
        </Field>
        <Field label={t("version")}><input className={inputCls} style={inputStyle} placeholder="1.20 – 1.21 or fixed" value={f.version} onChange={(e) => set("version", e.target.value)} /></Field>
        <Field label={t("server_type")}>
          <select className={inputCls} style={inputStyle} value={f.type} onChange={(e) => set("type", e.target.value)}>
            {["Survival", "Prison", "Creative", "Bedwars", "Skywars", "Mini games", "Roleplay", "Other"].map((o) => <option key={o}>{o}</option>)}
          </select>
        </Field>
      </div>

      <div className="mb-3">
        <p className="text-xs font-medium mb-1" style={{ color: C.muted }}>{t("links")}</p>
        <p className="text-[11px] mb-2" style={{ color: C.muted }}>{t("links_note")}</p>
        {f.links.map((u, i) => (
          <div key={i} className="flex gap-2 mb-2 items-center">
            <input className={inputCls} style={inputStyle} placeholder="https://discord.gg/…" value={u} onChange={(e) => setLink(i, e.target.value)} />
            {f.links.length > 1 && (
              <button type="button" onClick={() => setF((p) => ({ ...p, links: p.links.filter((_, idx) => idx !== i) }))} aria-label="Remove link">
                <X size={16} color={C.muted} />
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => setF((p) => ({ ...p, links: [...p.links, ""] }))}
          className="text-xs font-medium" style={{ color: C.green }}>+ {t("add_link")}</button>
      </div>

      <Field label={t("description")}><textarea rows={3} className={inputCls} style={inputStyle} value={f.desc} onChange={(e) => set("desc", e.target.value)} /></Field>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label={t("banner")}><ImagePicker value={f.banner} onChange={(v) => set("banner", v)} /></Field>
        <Field label={t("profile_pic")}><ImagePicker value={f.avatar} onChange={(v) => set("avatar", v)} /></Field>
      </div>
      <p className="text-[11px] mb-3" style={{ color: C.muted }}>{t("auto_delete_note")}</p>
      <SaveButton canSave={!!(f.name.trim() && hasIp)} onSave={() => onSave(buildPayload())}>{t("save")}</SaveButton>
    </Modal>
  );
}
function UptimeRow({ t, serverId }) {
  const [days, setDays] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = [];
      const today = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        try {
          const snap = await getDoc(doc(db, "servers", serverId, "uptimeLog", key));
          out.push(snap.exists() ? snap.data().online : null);
        } catch { out.push(null); }
      }
      if (!cancelled) setDays(out);
    })();
    return () => { cancelled = true; };
  }, [serverId]);

  if (!days) return null;
  return (
    <div className="mb-4">
      <p className="text-[11px] mb-1.5" style={{ color: C.muted }}>{t("uptime")}</p>
      <div className="flex gap-1">
        {days.map((online, i) => (
          <div key={i} className="flex-1 h-5 rounded-sm" title={online === null ? "No data" : online ? "Online" : "Offline"}
            style={{ background: online === null ? C.panel2 : online ? C.green : C.red, opacity: online === null ? 0.4 : 1 }} />
        ))}
      </div>
    </div>
  );
}

function ServerDetailModal({ s, t, session, onClose, onEdit, onDelete, onViewProfile }) {
  const [reviewStars, setReviewStars] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [reviews, setReviews] = useState([]);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState("");
  const [saving, setSaving] = useState(false);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const canManage = session.loggedIn && (session.uid === s.ownerId || session.role === "admin" || session.role === "owner");

  // Live list of everyone's reviews for this server, newest edit first.
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "servers", s.id, "reviews"),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
        setReviews(list);
        const mine = list.find((r) => r.id === session.uid);
        if (mine) { setReviewStars(mine.stars); setReviewText(mine.text || ""); }
      },
      (err) => console.error("[minebd] reviews listener error:", err)
    );
    return unsub;
  }, [s.id, session.uid]);

  // Live comment thread.
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "servers", s.id, "comments"),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
        setComments(list);
      },
      (err) => console.error("[minebd] comments listener error:", err)
    );
    return unsub;
  }, [s.id]);

  useEffect(() => {
    if (!session.uid) { setFollowing(false); return; }
    isFollowing("servers", s.id, session.uid).then(setFollowing).catch(() => {});
  }, [s.id, session.uid]);

  const myExistingReview = reviews.find((r) => r.id === session.uid);

  const share = () => { copyShareLink("servers", s.id); alert(t("link_copied")); };
  const handleClose = () => { resetShareUrl(); onClose(); };

  const submitReview = () => guardPost(session, async () => {
    setSaving(true);
    try {
      await submitServerReview(s.id, session.uid, session.name, reviewStars, reviewText);
    } catch (err) {
      console.error(err);
      alert("Couldn't save your review — " + (err?.message || "please try again."));
    } finally {
      setSaving(false);
    }
  });

  const submitComment = () => guardPost(session, async () => {
    if (!commentText.trim()) return;
    try {
      await postComment(s.id, session.uid, session.name, commentText.trim());
      await markPosted(session.uid);
      setCommentText("");
    } catch (err) {
      console.error(err);
      alert("Couldn't post your comment — " + (err?.message || "please try again."));
    }
  });

  const toggleFollowClick = () => guardPost(session, async () => {
    setFollowBusy(true);
    try { setFollowing(await toggleFollow("servers", s.id, session.uid)); }
    catch (err) { console.error(err); alert("Couldn't update follow — " + (err?.message || "please try again.")); }
    finally { setFollowBusy(false); }
  });

  return (
    <Modal title={s.name} onClose={handleClose} wide>
      <div className="h-32 rounded-xl mb-3" style={{ background: s.banner ? `url(${s.banner}) center/cover` : `linear-gradient(135deg, ${C.greenDeep}, #0A2119)` }} />
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <StatusDot online={s.online} /><span className="text-sm">{s.online ? t("online") : t("offline")}</span>
        <span className="text-sm flex items-center gap-1"><Users size={14} />{s.players || 0}/{s.cap || 100} {t("players")}</span>
        <Stars value={s.rating} /> <span className="text-xs" style={{ color: C.muted }}>({s.votes || 0})</span>
        <ListingBadges t={t} createdAt={s.createdAt} rating={s.rating} votes={s.votes} />
      </div>
      {(() => {
        const hosts = serverHosts(s);
        const rows = [];
        if (hosts.javaIp) rows.push({ label: "Java", text: hosts.javaPort ? `${hosts.javaIp}:${hosts.javaPort}` : hosts.javaIp });
        if (hosts.bedrockIp) rows.push({ label: "Bedrock", text: hosts.bedrockPort ? `${hosts.bedrockIp}:${hosts.bedrockPort}` : hosts.bedrockIp });
        hosts.extraHosts.forEach((h) => {
          rows.push({ label: h.label || "Other", text: h.port ? `${h.ip}:${h.port}` : h.ip });
        });
        if (!rows.length && s.ip) rows.push({ label: "", text: s.port ? `${s.ip}:${s.port}` : s.ip });
        return (
          <div className="flex flex-col gap-1.5 mb-3">
            {rows.map((r, i) => (
              <p key={i} className="text-sm px-2 py-1 rounded inline-flex items-center gap-2 border self-start" style={{ borderColor: C.border, background: C.panel2, fontFamily: "'JetBrains Mono', monospace" }}>
                {r.label ? <span className="text-[10px] font-semibold uppercase" style={{ color: C.muted }}>{r.label}</span> : null}
                <span>{r.text}</span>
              </p>
            ))}
          </div>
        );
      })()}
      <p className="text-sm mb-3">{s.desc}</p>
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-xs px-2 py-1 rounded-full" style={{ background: C.panel2, color: C.muted }}>{s.type}</span>
        <span className="text-xs px-2 py-1 rounded-full" style={{ background: C.panel2, color: C.muted }}>{s.platform}</span>
        <span className="text-xs px-2 py-1 rounded-full" style={{ background: C.panel2, color: C.muted }}>{s.version}</span>
      </div>

      <UptimeRow t={t} serverId={s.id} />

      <div className="flex flex-wrap gap-2 mb-5">
        {serverLinks(s).map((url, i) => (
          <a key={i} href={url} target="_blank" rel="noreferrer"><GhostButton icon={ChevronRight}>{t("visit")}{serverLinks(s).length > 1 ? ` ${i + 1}` : ""}</GhostButton></a>
        ))}
        <button onClick={toggleFollowClick} disabled={followBusy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border"
          style={following ? { background: C.green, borderColor: C.green, color: "#08130E" } : { borderColor: C.border, color: C.text }}>
          <Bookmark size={14} fill={following ? "#08130E" : "none"} /> {following ? t("following") : t("follow")}{s.followers ? ` (${s.followers})` : ""}
        </button>
        <GhostButton icon={Share2} onClick={share}>{t("share")}</GhostButton>
        {canManage && <GhostButton icon={Pencil} onClick={() => onEdit(s)}>{t("edit")}</GhostButton>}
        {canManage && <GhostButton icon={Trash2} onClick={() => confirmed(`Delete "${s.name}"? This can't be undone.`, () => onDelete(s.id))}>{t("delete")}</GhostButton>}
      </div>

      <SectionHeader icon={Star} title={`${t("reviews")}${s.votes ? ` (${s.votes})` : ""}`} />
      {!session.loggedIn || session.banned ? (
        <p className="text-xs mb-3" style={{ color: C.muted }}>{session.banned ? "Your account is banned and can't leave reviews." : t("login_required")}</p>
      ) : (
        <div className="mb-4 p-3 rounded-lg border" style={{ borderColor: C.border, background: C.panel2 }}>
          <p className="text-[11px] mb-2" style={{ color: C.muted }}>{myExistingReview ? "Edit your review" : t("write_review")}</p>
          <div className="flex items-center gap-1 mb-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <button key={i} onClick={() => setReviewStars(i)}>
                <Star size={18} fill={i <= reviewStars ? C.gold : "none"} color={i <= reviewStars ? C.gold : C.border} />
              </button>
            ))}
          </div>
          <textarea rows={2} className={inputCls} style={{ ...inputStyle, marginBottom: 8 }} placeholder={t("write_review") + "…"} value={reviewText} onChange={(e) => setReviewText(e.target.value)} />
          <PrimaryButton onClick={submitReview} disabled={saving}>{saving ? "…" : t("submit")}</PrimaryButton>
        </div>
      )}
      <div className="space-y-2 mb-5">
        {reviews.length === 0 && <p className="text-xs" style={{ color: C.muted }}>No reviews yet — be the first.</p>}
        {reviews.map((r) => (
          <div key={r.id} className="p-2 rounded-lg border" style={{ borderColor: C.border, background: C.panel2 }}>
            <div className="flex items-center gap-2 mb-1">
              <Stars value={r.stars} size={12} />
              <button onClick={() => onViewProfile(r.id)} className="font-medium text-xs">{r.name}</button>
              {r.id === session.uid && <span className="text-[10px]" style={{ color: C.muted }}>(you)</span>}
            </div>
            {r.text && <p className="text-xs" style={{ color: C.text }}>{r.text}</p>}
          </div>
        ))}
      </div>

      <SectionHeader icon={MessageCircle} title={`${t("comments")}${comments.length ? ` (${comments.length})` : ""}`} />
      {session.loggedIn && !session.banned && (
        <div className="flex gap-2 mb-3">
          <input className={inputCls} style={inputStyle} placeholder={t("write_comment")} value={commentText}
            onChange={(e) => setCommentText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitComment()} />
          <button onClick={submitComment} className="px-3 rounded-lg shrink-0" style={{ background: C.green }}><Send size={15} color="#08130E" /></button>
        </div>
      )}
      <div className="space-y-2">
        {comments.length === 0 && <p className="text-xs" style={{ color: C.muted }}>{t("no_comments")}</p>}
        {comments.map((c) => (
          <div key={c.id} className="p-2 rounded-lg border flex items-start justify-between gap-2" style={{ borderColor: C.border, background: C.panel2 }}>
            <div className="min-w-0">
              <button onClick={() => onViewProfile(c.uid)} className="font-medium text-xs">{c.name}</button>
              <p className="text-xs mt-0.5 break-words" style={{ color: C.text }}>{c.text}</p>
            </div>
            {(c.uid === session.uid || session.role === "admin" || session.role === "owner") && (
              <button onClick={() => confirmed("Delete this comment?", () => deleteComment(s.id, c.id))} className="shrink-0"><Trash2 size={13} color={C.muted} /></button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
function ServersSection({ t, session, coll, ads, openId, onConsumeOpenId, onViewProfile }) {
  const [q, setQ] = useState(""); const [typeFilter, setTypeFilter] = useState("all"); const [platformFilter, setPlatformFilter] = useState("all");
  const [versionFilter, setVersionFilter] = useState("all");
  const [showForm, setShowForm] = useState(false); const [editing, setEditing] = useState(null); const [active, setActive] = useState(null);
  const [live, setLive] = useState({});       // id -> { online, players, cap }
  const [pinging, setPinging] = useState(false);
  const servers = coll.items;

  // Open the shared server's detail modal once its data has loaded, then
  // clear the pending id so it doesn't reopen if the user closes it.
  useEffect(() => {
    if (!openId || !servers.length) return;
    const match = servers.find((s) => s.id === openId);
    if (match) setActive(match);
    else alert("That shared server link doesn't match anything here anymore — it may have been removed.");
    onConsumeOpenId();
  }, [openId, servers]);

  const runPing = async (list) => {
    if (!list.length) return;
    setPinging(true);
    try {
      const results = await pingServers(list);
      setLive((prev) => ({ ...prev, ...results }));
      const todayKey = new Date().toISOString().slice(0, 10);
      // Keep lastSeen fresh for servers that really answered, and correct
      // the stored online/player counts either way — this is what makes
      // the 7-week auto-delete rule and the player counts actually real.
      await Promise.all(Object.entries(results).map(([id, status]) => {
        const s = list.find((x) => x.id === id);
        if (!s) return null;
        const patch = status.online
          ? { online: true, players: status.players, cap: status.cap || s.cap || 100, lastSeen: Date.now() }
          : { online: false };
        return Promise.all([
          coll.update(id, patch).catch(() => {}),
          // One doc per server per day — today's ping result is what
          // that day's uptime dot shows, overwritten if pinged again today.
          setDoc(doc(db, "servers", id, "uptimeLog", todayKey), { online: status.online }).catch(() => {}),
        ]);
      }));
    } finally {
      setPinging(false);
    }
  };

  // Ping every server once whenever the list changes (new server added, etc.)
  useEffect(() => {
    if (servers.length) runPing(servers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.map((s) => s.id + (s.javaIp || s.ip || "") + (s.bedrockIp || "") + (s.javaPort || s.port || "") + (s.bedrockPort || "")).join(",")]);

  const merged = useMemo(
    () => servers.map((s) => (live[s.id] ? { ...s, online: live[s.id].online, players: live[s.id].players, cap: live[s.id].cap || s.cap } : s)),
    [servers, live]
  );

  const versions = useMemo(() => ["all", ...Array.from(new Set(servers.map((s) => s.version).filter(Boolean)))], [servers]);

  const visible = useMemo(() => merged
    .filter((s) => !s.lastSeen || Date.now() - s.lastSeen < WEEK)
    .filter((s) => (typeFilter === "all" ? true : s.type === typeFilter))
    .filter((s) => (platformFilter === "all" ? true : s.platform === platformFilter))
    .filter((s) => (versionFilter === "all" ? true : s.version === versionFilter))
    .filter((s) => (q ? (s.name + s.desc).toLowerCase().includes(q.toLowerCase()) : true))
    .sort((a, b) => (b.rating || 0) - (a.rating || 0)), [merged, q, typeFilter, platformFilter, versionFilter]);

  const save = async (data) => {
    if (editing) {
      await deleteReplacedImages(editing, data);
      await coll.update(editing.id, data);
    } else {
      await coll.add({ ...data, online: true, players: 0, cap: 100, rating: 0, votes: 0, followers: 0, createdAt: Date.now(), ownerId: session.uid, lastSeen: Date.now() });
      await markPosted(session.uid);
    }
    setShowForm(false); setEditing(null);
  };
  const remove = async (id) => {
    const item = servers.find((s) => s.id === id) || active;
    await deleteImagesFromRecord(item);
    await coll.remove(id);
    setActive(null);
  };
  const types = ["all", "Survival", "Prison", "Creative", "Bedwars", "Skywars", "Mini games", "Roleplay", "Other"];

  return (
    <div>
      <SectionHeader icon={ServerIcon} title={t("nav_servers")} action={
        <PrimaryButton icon={Plus} onClick={() => guardPost(session, () => setShowForm(true))}>{t("add_server")}</PrimaryButton>
      } />
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-2.5 top-3 sm:top-2.5" color={C.muted} />
          <input className={inputCls + " pl-8"} style={inputStyle} placeholder={t("search_ph")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={inputCls} style={{ ...inputStyle, maxWidth: "100%" }} value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}>
          <option value="all">{t("platform")}: {t("all")}</option><option>Java</option><option>Bedrock</option><option>Java & Bedrock</option>
        </select>
        {versions.length > 1 && (
          <select className={inputCls} style={{ ...inputStyle, maxWidth: "100%" }} value={versionFilter} onChange={(e) => setVersionFilter(e.target.value)}>
            <option value="all">{t("version_filter")}: {t("all")}</option>
            {versions.filter((v) => v !== "all").map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <button onClick={() => runPing(servers)} disabled={pinging} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border shrink-0" style={{ borderColor: C.border, color: C.text }}>
          {pinging ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />} {pinging ? "Pinging…" : "Refresh status"}
        </button>
      </div>
      <div className="flex gap-2 flex-nowrap overflow-x-auto pb-1 mb-4 -mx-1 px-1">
        {types.map((tp) => <Pill key={tp} active={typeFilter === tp} onClick={() => setTypeFilter(tp)}>{tp === "all" ? t("all") : tp}</Pill>)}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.length === 0 && <p className="text-sm col-span-full" style={{ color: C.muted }}>{t("no_results")}</p>}
        {interleaveAds(visible, adsForCategory(ads.items, "servers")).map((row, i) =>
          row.kind === "ad"
            ? <AdSlot key={`ad-${row.data.id}-${i}`} ad={row.data} t={t} category="servers" viewerUid={session.uid} />
            : <ServerCard key={row.data.id} s={row.data} t={t} onOpen={setActive} />
        )}
      </div>
      {showForm && <ServerFormModal t={t} initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} />}
      {active && <ServerDetailModal s={active} t={t} session={session} onClose={() => setActive(null)} onViewProfile={onViewProfile}
        onEdit={(s) => { setEditing(s); setShowForm(true); setActive(null); }} onDelete={remove} />}
    </div>
  );
}

// =============================================================================
// EVENTS
// =============================================================================
function fmtTimeLeft(createdAt, durationHours, t) {
  const diff = createdAt + durationHours * HOUR - Date.now();
  if (diff <= 0) return t("expired");
  const h = Math.floor(diff / HOUR), m = Math.floor((diff % HOUR) / 60000);
  return `${h}h ${m}m ${t("time_left")}`;
}
function EventFormModal({ t, servers, initial, onClose, onSave }) {
  const [f, setF] = useState(initial || { title: "", serverId: servers[0]?.id || "", durationHours: 24, desc: "", banner: null });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title={initial ? `${t("edit")} — ${t("nav_events")}` : t("add_event")} onClose={onClose}>
      <Field label={t("event_title") + " *"}><input className={inputCls} style={inputStyle} value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
      <Field label={t("event_server") + " *"}>
        <select className={inputCls} style={inputStyle} value={f.serverId} onChange={(e) => set("serverId", e.target.value)}>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label={t("event_duration")}>
        <input type="range" min={1} max={48} value={f.durationHours} className="w-full" onChange={(e) => set("durationHours", Number(e.target.value))} />
        <span className="text-xs" style={{ color: C.muted }}>{f.durationHours}h</span>
      </Field>
      <Field label={t("description")}><textarea rows={3} className={inputCls} style={inputStyle} value={f.desc} onChange={(e) => set("desc", e.target.value)} /></Field>
      <Field label={t("banner")}><ImagePicker value={f.banner} onChange={(v) => set("banner", v)} /></Field>
      <SaveButton canSave={!!(f.title && f.serverId)} onSave={() => onSave(f)}>{t("save")}</SaveButton>
    </Modal>
  );
}

function EventCard({ ev, t, session, server, flashed, canManage, onDelete, onEdit, onShare }) {
  const [going, setGoing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session.uid) { setGoing(false); return; }
    getMyRsvp(ev.id, session.uid).then(setGoing).catch(() => {});
  }, [ev.id, session.uid]);

  const rsvp = () => guardPost(session, async () => {
    setBusy(true);
    try { setGoing(await toggleRsvp(ev.id, session.uid)); }
    catch (err) { console.error(err); alert("Couldn't update RSVP — " + (err?.message || "please try again.")); }
    finally { setBusy(false); }
  });

  return (
    <div className="rounded-xl border overflow-hidden transition-shadow" style={{ borderColor: flashed ? C.green : C.border, background: C.panel, boxShadow: flashed ? `0 0 0 2px ${C.green}` : "none" }}>
      <div className="h-20" style={{ background: ev.banner ? `url(${ev.banner}) center/cover` : `linear-gradient(135deg, ${C.redDeep}, #250A0D)` }} />
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold text-sm">{ev.title}</p>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onShare}><Share2 size={14} color={C.muted} /></button>
            {canManage && onEdit && <button onClick={onEdit}><Pencil size={14} color={C.muted} /></button>}
            {canManage && <button onClick={() => confirmed(`Delete "${ev.title}"? This can't be undone.`, onDelete)}><Trash2 size={14} color={C.muted} /></button>}
          </div>
        </div>
        <p className="text-[11px] mb-1" style={{ color: C.muted }}>@ {server?.name || "—"}</p>
        <p className="text-xs mb-2 line-clamp-2">{ev.desc}</p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] flex items-center gap-1 font-medium" style={{ color: C.red }}><Clock size={12} /> {fmtTimeLeft(ev.createdAt, ev.durationHours, t)}</span>
          <button onClick={rsvp} disabled={busy} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border"
            style={going ? { background: C.green, borderColor: C.green, color: "#08130E" } : { borderColor: C.border, color: C.text }}>
            <CheckCheck size={12} /> {ev.rsvpCount || 0} {t("interested")}
          </button>
        </div>
      </div>
    </div>
  );
}

function EventsSection({ t, session, servers, coll, ads, openId, onConsumeOpenId }) {
  const [q, setQ] = useState(""); const [showForm, setShowForm] = useState(false); const [editing, setEditing] = useState(null);
  const flashId = useFlashHighlight(openId, coll.items.length > 0, onConsumeOpenId);
  const visible = useMemo(() => coll.items
    .filter((e) => Date.now() < e.createdAt + e.durationHours * HOUR)
    .filter((e) => (q ? e.title.toLowerCase().includes(q.toLowerCase()) : true))
    .sort((a, b) => b.createdAt - a.createdAt), [coll.items, q]);

  const save = async (f) => {
    if (editing) {
      await deleteReplacedImages(editing, f);
      await coll.update(editing.id, { title: f.title, serverId: f.serverId, durationHours: f.durationHours, desc: f.desc, banner: f.banner });
    } else {
      await coll.add({ ...f, createdAt: Date.now(), rsvpCount: 0, ownerId: session.uid });
      await markPosted(session.uid);
      const server = servers.find((s) => s.id === f.serverId);
      if (server) notifyFollowers("servers", server.id, { type: "event", message: `New event on ${server.name}: ${f.title}`, link: `/servers/${server.id}` });
    }
    setShowForm(false); setEditing(null);
  };
  const remove = async (ev) => {
    await deleteImagesFromRecord(ev);
    await coll.remove(ev.id);
  };
  const share = (id) => { copyShareLink("events", id); alert(t("link_copied")); };

  return (
    <div>
      <SectionHeader icon={Calendar} title={t("nav_events")} action={
        <PrimaryButton icon={Plus} onClick={() => guardPost(session, () => servers.length ? setShowForm(true) : alert("Add a server first."))}>{t("add_event")}</PrimaryButton>
      } />
      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="absolute left-2.5 top-3 sm:top-2.5" color={C.muted} />
        <input className={inputCls + " pl-8"} style={inputStyle} placeholder={t("search_ph")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.length === 0 && <p className="text-sm col-span-full" style={{ color: C.muted }}>{t("no_results")}</p>}
        {interleaveAds(visible, adsForCategory(ads.items, "events")).map((row, i) => {
          if (row.kind === "ad") return <AdSlot key={`ad-${row.data.id}-${i}`} ad={row.data} t={t} category="events" viewerUid={session.uid} />;
          const ev = row.data;
          const server = servers.find((s) => s.id === ev.serverId);
          const canManage = session.loggedIn && (session.uid === ev.ownerId || session.role === "admin" || session.role === "owner");
          return (
            <EventCard key={ev.id} ev={ev} t={t} session={session} server={server} flashed={ev.id === flashId} canManage={canManage}
              onDelete={() => remove(ev)} onEdit={() => { setEditing(ev); setShowForm(true); }} onShare={() => share(ev.id)} />
          );
        })}
      </div>
      {showForm && <EventFormModal t={t} servers={servers} initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} />}
    </div>
  );
}

// =============================================================================
// REPORTS
// =============================================================================
function ReportFormModal({ t, initial, onClose, onSave }) {
  const [kind, setKind] = useState(initial?.kind || "player");
  const [f, setF] = useState(initial || { platform: "Java", target: "", type: "Hacking", desc: "", proof: null });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title={initial ? `${t("edit")} — ${t("nav_reports")}` : t("add_report")} onClose={onClose}>
      <div className="flex gap-2 mb-3"><Pill active={kind === "player"} onClick={() => setKind("player")}>{t("report_player")}</Pill><Pill active={kind === "server"} onClick={() => setKind("server")}>{t("report_server")}</Pill></div>
      {kind === "player" ? (
        <>
          <Field label={t("platform") + " *"}><select className={inputCls} style={inputStyle} value={f.platform} onChange={(e) => set("platform", e.target.value)}><option>Java</option><option>Bedrock</option></select></Field>
          <Field label={t("gamertag") + " *"}><input className={inputCls} style={inputStyle} value={f.target} onChange={(e) => set("target", e.target.value)} /></Field>
          <Field label={t("report_type")}><select className={inputCls} style={inputStyle} value={f.type} onChange={(e) => set("type", e.target.value)}>{["Hacking", "Harassment", "Griefing", "Scamming", "Other"].map((o) => <option key={o}>{o}</option>)}</select></Field>
        </>
      ) : (
        <>
          <Field label={t("ip_port") + " *"}><input className={inputCls} style={inputStyle} value={f.target} onChange={(e) => set("target", e.target.value)} /></Field>
          <Field label={t("report_type")}><select className={inputCls} style={inputStyle} value={f.type} onChange={(e) => set("type", e.target.value)}>{["Scam", "Admin abuse", "Pay-to-win false ad", "Other"].map((o) => <option key={o}>{o}</option>)}</select></Field>
        </>
      )}
      <Field label={t("description") + " *"}><textarea rows={3} className={inputCls} style={inputStyle} value={f.desc} onChange={(e) => set("desc", e.target.value)} /></Field>
      <Field label={t("proof")}><ImagePicker value={f.proof} onChange={(v) => set("proof", v)} /></Field>
      <SaveButton canSave={!!(f.target && f.desc)} onSave={() => onSave({ ...f, kind })}>{t("save")}</SaveButton>
    </Modal>
  );
}
function ReportCard({ r, t, session, canManage, onDelete, onEdit }) {
  const [myVote, setMyVote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [myFlag, setMyFlag] = useState(false);
  const [flagBusy, setFlagBusy] = useState(false);

  useEffect(() => {
    if (!session.uid) { setMyVote(null); setMyFlag(false); return; }
    getMyReportVote(r.id, session.uid).then(setMyVote).catch(() => {});
    getMyReportFlag(r.id, session.uid).then(setMyFlag).catch(() => {});
  }, [r.id, session.uid]);

  const cast = (dir) => guardPost(session, async () => {
    setBusy(true);
    try {
      const result = await toggleReportVote(r.id, session.uid, dir);
      setMyVote(result);
    } catch (err) {
      console.error(err);
      alert("Couldn't record your vote — " + (err?.message || "please try again."));
    } finally {
      setBusy(false);
    }
  });

  const flag = () => guardPost(session, async () => {
    setFlagBusy(true);
    try {
      const nowFlagged = await toggleReportFlag(r.id, session.uid);
      setMyFlag(nowFlagged);
      alert(nowFlagged ? "Flagged for moderator review." : "Flag removed.");
    } catch (err) {
      console.error(err);
      alert("Couldn't flag this report — " + (err?.message || "please try again."));
    } finally {
      setFlagBusy(false);
    }
  });

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: C.border, background: C.panel }}>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: r.kind === "player" ? C.red : C.green, color: "#0A0A0A" }}>{r.kind === "player" ? t("report_player") : t("report_server")}</span>
        <span className="font-semibold text-sm">{r.target}</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: C.panel2, color: C.muted }}>{r.type}</span>
      </div>
      <p className="text-sm mb-2">{r.desc}</p>
      {r.proof && <img src={r.proof} className="rounded-lg mb-2 max-h-40" />}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => cast("up")} disabled={busy} className="flex items-center gap-1 text-xs" style={myVote === "up" ? { color: C.green } : undefined}>
          <ThumbsUp size={14} color={C.green} fill={myVote === "up" ? C.green : "none"} />{r.up || 0}
        </button>
        <button onClick={() => cast("down")} disabled={busy} className="flex items-center gap-1 text-xs" style={myVote === "down" ? { color: C.red } : undefined}>
          <ThumbsDown size={14} color={C.red} fill={myVote === "down" ? C.red : "none"} />{r.down || 0}
        </button>
        <button onClick={flag} disabled={flagBusy} className="flex items-center gap-1 text-xs" style={{ color: myFlag ? C.gold : C.muted }}>
          <Flag size={14} fill={myFlag ? C.gold : "none"} />{t("flag_false")}{r.flagged ? ` (${r.flagged})` : ""}
        </button>
        {canManage && (
          <span className="flex items-center gap-2 ml-auto">
            {onEdit && <button onClick={onEdit} className="flex items-center gap-1 text-xs" style={{ color: C.muted }}><Pencil size={14} />{t("edit")}</button>}
            <button onClick={() => confirmed("Delete this report? This can't be undone.", () => onDelete(r))} className="flex items-center gap-1 text-xs" style={{ color: C.red }}><Trash2 size={14} />{t("delete")}</button>
          </span>
        )}
      </div>
    </div>
  );
}
function ReportsSection({ t, session, coll, ads }) {
  const [q, setQ] = useState(""); const [showForm, setShowForm] = useState(false); const [editing, setEditing] = useState(null);
  const visible = coll.items.filter((r) => (q ? (r.target + r.desc).toLowerCase().includes(q.toLowerCase()) : true))
    .sort((a, b) => ((b.up || 0) - (b.down || 0)) - ((a.up || 0) - (a.down || 0)));
  const save = async (f) => {
    if (editing) {
      await deleteReplacedImages(editing, f);
      await coll.update(editing.id, { kind: f.kind, platform: f.platform, target: f.target, type: f.type, desc: f.desc, proof: f.proof });
    } else {
      await coll.add({ ...f, up: 0, down: 0, ownerId: session.uid, createdAt: Date.now() });
      await markPosted(session.uid);
    }
    setShowForm(false); setEditing(null);
  };
  const remove = async (r) => {
    await deleteImagesFromRecord(r);
    await coll.remove(r.id);
  };

  return (
    <div>
      <SectionHeader icon={Flag} title={t("nav_reports")} action={
        <PrimaryButton icon={Plus} onClick={() => guardPost(session, () => { setEditing(null); setShowForm(true); })}>{t("add_report")}</PrimaryButton>
      } />
      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="absolute left-2.5 top-3 sm:top-2.5" color={C.muted} />
        <input className={inputCls + " pl-8"} style={inputStyle} placeholder={t("search_ph")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="space-y-3">
        {visible.length === 0 && <p className="text-sm" style={{ color: C.muted }}>{t("no_results")}</p>}
        {interleaveAds(visible, adsForCategory(ads.items, "reports"), 4).map((row, i) => {
          if (row.kind === "ad") return <AdSlot key={`ad-${row.data.id}-${i}`} ad={row.data} t={t} category="reports" viewerUid={session.uid} />;
          const r = row.data;
          const canManage = session.loggedIn && (session.uid === r.ownerId || session.role === "admin" || session.role === "owner");
          return <ReportCard key={r.id} r={r} t={t} session={session} canManage={canManage} onDelete={remove} onEdit={() => { setEditing(r); setShowForm(true); }} />;
        })}
      </div>
      {showForm && <ReportFormModal t={t} initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} />}
    </div>
  );
}

// =============================================================================
// MARKETPLACE
// =============================================================================
function ResourceFormModal({ t, initial, onClose, onSave }) {
  const [f, setF] = useState(initial || { name: "", type: "Plugin", platform: "Java", version: "", desc: "", link: "", pricing: "free", price: 0, img: null });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title={initial ? `${t("edit")} — ${t("nav_market")}` : t("add_resource")} onClose={onClose} wide>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label={t("resource_name") + " *"}><input className={inputCls} style={inputStyle} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label={t("resource_type")}><select className={inputCls} style={inputStyle} value={f.type} onChange={(e) => set("type", e.target.value)}><option>Plugin</option><option>Mod</option><option>Texture</option><option>World</option></select></Field>
        <Field label={t("platform")}><select className={inputCls} style={inputStyle} value={f.platform} onChange={(e) => set("platform", e.target.value)}><option>Java</option><option>Bedrock</option><option>Java & Bedrock</option><option>Modded</option></select></Field>
        <Field label={t("version")}><input className={inputCls} style={inputStyle} value={f.version} onChange={(e) => set("version", e.target.value)} /></Field>
        <Field label="Download link *"><input className={inputCls} style={inputStyle} value={f.link} onChange={(e) => set("link", e.target.value)} /></Field>
        <Field label={t("dev_payment")}><div className="flex gap-2"><Pill active={f.pricing === "free"} onClick={() => set("pricing", "free")}>{t("free")}</Pill><Pill active={f.pricing === "paid"} onClick={() => set("pricing", "paid")}>{t("paid")}</Pill></div></Field>
        {f.pricing === "paid" && <Field label={t("price")}><input type="number" className={inputCls} style={inputStyle} value={f.price} onChange={(e) => set("price", Number(e.target.value))} /></Field>}
      </div>
      <Field label={t("description")}><textarea rows={3} className={inputCls} style={inputStyle} value={f.desc} onChange={(e) => set("desc", e.target.value)} /></Field>
      <Field label="Picture"><ImagePicker value={f.img} onChange={(v) => set("img", v)} /></Field>
      <SaveButton canSave={!!(f.name && f.link)} onSave={() => onSave(f)}>{t("save")}</SaveButton>
    </Modal>
  );
}

function ResourceDetailModal({ r, t, session, onClose, onDelete, onEdit, canManage }) {
  const [reviewStars, setReviewStars] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [reviews, setReviews] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "resources", r.id, "reviews"),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
        setReviews(list);
        const mine = list.find((x) => x.id === session.uid);
        if (mine) { setReviewStars(mine.stars); setReviewText(mine.text || ""); }
      },
      (err) => console.error("[minebd] resource reviews listener error:", err)
    );
    return unsub;
  }, [r.id, session.uid]);

  const share = () => { copyShareLink("resources", r.id); alert(t("link_copied")); };
  const handleClose = () => { resetShareUrl(); onClose(); };

  const submitReview = () => guardPost(session, async () => {
    setSaving(true);
    try { await submitResourceReview(r.id, session.uid, session.name, reviewStars, reviewText); }
    catch (err) { console.error(err); alert("Couldn't save your review — " + (err?.message || "please try again.")); }
    finally { setSaving(false); }
  });

  return (
    <Modal title={r.name} onClose={handleClose} wide>
      <div className="h-28 rounded-xl mb-3 flex items-center justify-center" style={{ background: r.img ? `url(${r.img}) center/cover` : C.panel2 }}>{!r.img && <Wrench color={C.muted} />}</div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Stars value={r.rating} /> <span className="text-xs" style={{ color: C.muted }}>({r.votes || 0})</span>
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: r.pricing === "free" ? C.greenDeep : "#3A2410", color: r.pricing === "free" ? C.green : C.gold }}>{r.pricing === "free" ? t("free") : `৳${r.price}`}</span>
        <ListingBadges t={t} createdAt={r.createdAt} rating={r.rating} votes={r.votes} />
      </div>
      <p className="text-[11px] mb-2" style={{ color: C.muted }}>{r.type} · {r.platform} · {r.version}</p>
      <p className="text-sm mb-4">{r.desc}</p>
      <div className="flex flex-wrap gap-2 mb-5">
        <a href={r.link} target="_blank" rel="noreferrer"><PrimaryButton icon={Upload}>{t("download")}</PrimaryButton></a>
        <GhostButton icon={Share2} onClick={share}>{t("share")}</GhostButton>
        {canManage && onEdit && <GhostButton icon={Pencil} onClick={() => { onEdit(r); handleClose(); }}>{t("edit")}</GhostButton>}
        {canManage && <GhostButton icon={Trash2} onClick={() => confirmed(`Delete "${r.name}"? This can't be undone.`, () => { onDelete(r); handleClose(); })}>{t("delete")}</GhostButton>}
      </div>

      <SectionHeader icon={Star} title={`${t("reviews")}${r.votes ? ` (${r.votes})` : ""}`} />
      {!session.loggedIn || session.banned ? (
        <p className="text-xs mb-3" style={{ color: C.muted }}>{session.banned ? "Your account is banned and can't leave reviews." : t("login_required")}</p>
      ) : (
        <div className="mb-4 p-3 rounded-lg border" style={{ borderColor: C.border, background: C.panel2 }}>
          <div className="flex items-center gap-1 mb-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <button key={i} onClick={() => setReviewStars(i)}>
                <Star size={18} fill={i <= reviewStars ? C.gold : "none"} color={i <= reviewStars ? C.gold : C.border} />
              </button>
            ))}
          </div>
          <textarea rows={2} className={inputCls} style={{ ...inputStyle, marginBottom: 8 }} placeholder={t("write_review") + "…"} value={reviewText} onChange={(e) => setReviewText(e.target.value)} />
          <PrimaryButton onClick={submitReview} disabled={saving}>{saving ? "…" : t("submit")}</PrimaryButton>
        </div>
      )}
      <div className="space-y-2">
        {reviews.length === 0 && <p className="text-xs" style={{ color: C.muted }}>No reviews yet — be the first.</p>}
        {reviews.map((rv) => (
          <div key={rv.id} className="p-2 rounded-lg border" style={{ borderColor: C.border, background: C.panel2 }}>
            <div className="flex items-center gap-2 mb-1">
              <Stars value={rv.stars} size={12} />
              <span className="font-medium text-xs">{rv.name}</span>
              {rv.id === session.uid && <span className="text-[10px]" style={{ color: C.muted }}>(you)</span>}
            </div>
            {rv.text && <p className="text-xs">{rv.text}</p>}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ResourceCard({ r, t, flashed, canManage, onOpen, onShare, onDelete, onEdit }) {
  return (
    <div className="rounded-xl border overflow-hidden transition-shadow cursor-pointer" style={{ borderColor: flashed ? C.green : C.border, background: C.panel, boxShadow: flashed ? `0 0 0 2px ${C.green}` : "none" }} onClick={onOpen}>
      <div className="h-24 flex items-center justify-center" style={{ background: r.img ? `url(${r.img}) center/cover` : C.panel2 }}>{!r.img && <Wrench color={C.muted} />}</div>
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-sm truncate">{r.name}</p>
          <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: r.pricing === "free" ? C.greenDeep : "#3A2410", color: r.pricing === "free" ? C.green : C.gold }}>{r.pricing === "free" ? t("free") : `৳${r.price}`}</span>
            <button onClick={onShare}><Share2 size={14} color={C.muted} /></button>
            {canManage && onEdit && <button onClick={onEdit}><Pencil size={14} color={C.muted} /></button>}
            {canManage && <button onClick={() => confirmed(`Delete "${r.name}"? This can't be undone.`, onDelete)}><Trash2 size={14} color={C.muted} /></button>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          <p className="text-[11px]" style={{ color: C.muted }}>{r.type} · {r.platform} · {r.version}</p>
          <ListingBadges t={t} createdAt={r.createdAt} rating={r.rating} votes={r.votes} />
        </div>
        <div className="flex items-center gap-2 my-1.5">
          <Stars value={r.rating} size={12} /> <span className="text-[11px]" style={{ color: C.muted }}>({r.votes || 0})</span>
        </div>
        <p className="text-xs mb-2 line-clamp-2">{r.desc}</p>
        <a href={r.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><PrimaryButton full>{t("download")}</PrimaryButton></a>
      </div>
    </div>
  );
}

function MarketSection({ t, session, coll, ads, openId, onConsumeOpenId }) {
  const [q, setQ] = useState(""); const [typeFilter, setTypeFilter] = useState("all"); const [versionFilter, setVersionFilter] = useState("all");
  const [showForm, setShowForm] = useState(false); const [editing, setEditing] = useState(null); const [active, setActive] = useState(null);
  const flashId = useFlashHighlight(openId, coll.items.length > 0, onConsumeOpenId);
  const types = ["all", "Plugin", "Mod", "Texture", "World"];
  const versions = useMemo(() => ["all", ...Array.from(new Set(coll.items.map((r) => r.version).filter(Boolean)))], [coll.items]);
  const visible = coll.items
    .filter((r) => (typeFilter === "all" ? true : r.type === typeFilter))
    .filter((r) => (versionFilter === "all" ? true : r.version === versionFilter))
    .filter((r) => (q ? (r.name + r.desc).toLowerCase().includes(q.toLowerCase()) : true));

  const save = async (f) => {
    if (editing) {
      await deleteReplacedImages(editing, f);
      await coll.update(editing.id, { name: f.name, type: f.type, platform: f.platform, version: f.version, desc: f.desc, link: f.link, pricing: f.pricing, price: f.price, img: f.img });
    } else {
      await coll.add({ ...f, rating: 0, votes: 0, createdAt: Date.now(), ownerId: session.uid });
      await markPosted(session.uid);
    }
    setShowForm(false); setEditing(null);
  };
  const remove = async (itemOrId) => {
    const item = typeof itemOrId === "object" ? itemOrId : (coll.items.find((x) => x.id === itemOrId) || active);
    await deleteImagesFromRecord(item);
    await coll.remove(typeof itemOrId === "object" ? itemOrId.id : itemOrId);
    setActive(null);
  };
  const share = (id) => { copyShareLink("resources", id); alert(t("link_copied")); };

  return (
    <div>
      <SectionHeader icon={Package} title={t("nav_market")} action={
        <PrimaryButton icon={Upload} onClick={() => guardPost(session, () => setShowForm(true))}>{t("add_resource")}</PrimaryButton>
      } />
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-2.5 top-3 sm:top-2.5" color={C.muted} />
          <input className={inputCls + " pl-8"} style={inputStyle} placeholder={t("search_ph")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {versions.length > 1 && (
          <select className={inputCls} style={{ ...inputStyle, maxWidth: "100%" }} value={versionFilter} onChange={(e) => setVersionFilter(e.target.value)}>
            <option value="all">{t("version_filter")}: {t("all")}</option>
            {versions.filter((v) => v !== "all").map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
      </div>
      <div className="flex gap-2 flex-nowrap overflow-x-auto pb-1 mb-4 -mx-1 px-1">
        {types.map((tp) => <Pill key={tp} active={typeFilter === tp} onClick={() => setTypeFilter(tp)}>{tp === "all" ? t("all") : tp}</Pill>)}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.length === 0 && <p className="text-sm col-span-full" style={{ color: C.muted }}>{t("no_results")}</p>}
        {interleaveAds(visible, adsForCategory(ads.items, "market")).map((row, i) => {
          if (row.kind === "ad") return <AdSlot key={`ad-${row.data.id}-${i}`} ad={row.data} t={t} category="market" viewerUid={session.uid} />;
          const r = row.data;
          const canManage = session.loggedIn && (session.uid === r.ownerId || session.role === "admin" || session.role === "owner");
          return (
            <ResourceCard key={r.id} r={r} t={t} flashed={r.id === flashId} canManage={canManage}
              onOpen={() => setActive(r)} onShare={() => share(r.id)} onDelete={() => remove(r)}
              onEdit={() => { setEditing(r); setShowForm(true); }} />
          );
        })}
      </div>
      {showForm && <ResourceFormModal t={t} initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} />}
      {active && (
        <ResourceDetailModal r={active} t={t} session={session} onClose={() => setActive(null)} onDelete={remove}
          onEdit={(r) => { setEditing(r); setShowForm(true); }}
          canManage={session.loggedIn && (session.uid === active.ownerId || session.role === "admin" || session.role === "owner")} />
      )}
    </div>
  );
}

// =============================================================================
// HIRE A DEVELOPER
// =============================================================================
function DevFormModal({ t, initial, onClose, onSave }) {
  const [f, setF] = useState(initial || { name: "", type: "Server", cv: "", payment: "paid", contact: "" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title={initial ? `${t("edit")} — ${t("nav_devs")}` : t("add_dev")} onClose={onClose}>
      <Field label={t("dev_name") + " *"}><input className={inputCls} style={inputStyle} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
      <Field label={t("dev_type")}><select className={inputCls} style={inputStyle} value={f.type} onChange={(e) => set("type", e.target.value)}><option>Server</option><option>Mod</option><option>Plugin</option><option>Website</option></select></Field>
      <Field label={t("dev_cv") + " *"}><textarea rows={3} className={inputCls} style={inputStyle} value={f.cv} onChange={(e) => set("cv", e.target.value)} /></Field>
      <Field label={t("dev_payment")}><div className="flex gap-2"><Pill active={f.payment === "paid"} onClick={() => set("payment", "paid")}>{t("paid")}</Pill><Pill active={f.payment === "free"} onClick={() => set("payment", "free")}>{t("free")}</Pill></div></Field>
      <Field label={t("dev_contact") + " *"}><input className={inputCls} style={inputStyle} value={f.contact} onChange={(e) => set("contact", e.target.value)} /></Field>
      <SaveButton canSave={!!(f.name && f.cv && f.contact)} onSave={() => onSave(f)}>{t("submit")}</SaveButton>
    </Modal>
  );
}
/** Compact list card — full LinkedIn-style profile opens on click. */
function DevCard({ d, t, highlighted, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(d)}
      className="w-full text-left rounded-xl border p-3 flex items-center gap-3 transition-shadow active:opacity-90"
      style={{ borderColor: highlighted ? C.green : C.border, background: C.panel, boxShadow: highlighted ? `0 0 0 2px ${C.green}` : "none" }}
    >
      <div className="w-12 h-12 rounded-full flex items-center justify-center shrink-0 text-base font-bold"
        style={{ background: C.greenDeep, color: C.green }}>
        {(d.name || "?")[0].toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm truncate flex items-center gap-1">
          {d.name} <VerifiedTick show={d.verified} />
        </p>
        <p className="text-[11px] truncate" style={{ color: C.muted }}>
          {d.type} · {d.payment === "paid" ? t("paid") : t("free")}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <Stars value={d.rating} size={12} />
          <span className="text-[11px]" style={{ color: C.muted }}>
            {d.votes ? `(${d.votes})` : ""}{d.followers ? ` · ${d.followers} ${t("followers")}` : ""}
          </span>
        </div>
      </div>
      <ChevronRight size={18} color={C.muted} className="shrink-0" />
    </button>
  );
}

/** LinkedIn-style full developer profile. */
function DevProfileModal({ d, t, session, canManage, onClose, onDelete, onEdit }) {
  const [myRating, setMyRating] = useState(null);
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState(false);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  useEffect(() => {
    if (!session.uid) { setMyRating(null); setFollowing(false); return; }
    getMyDevRating(d.id, session.uid).then(setMyRating).catch(() => {});
    isFollowing("developers", d.id, session.uid).then(setFollowing).catch(() => {});
  }, [d.id, session.uid]);

  const rate = (stars) => guardPost(session, async () => {
    setBusy(true);
    try {
      await submitDevRating(d.id, session.uid, stars);
      setMyRating(stars);
    } catch (err) {
      console.error(err);
      alert("Couldn't save your rating — " + (err?.message || "please try again."));
    } finally {
      setBusy(false);
    }
  });

  const toggleFollowClick = () => guardPost(session, async () => {
    setFollowBusy(true);
    try { setFollowing(await toggleFollow("developers", d.id, session.uid)); }
    catch (err) { console.error(err); alert("Couldn't update follow — " + (err?.message || "please try again.")); }
    finally { setFollowBusy(false); }
  });

  const handleClose = () => { resetShareUrl(); onClose(); };

  return (
    <Modal title={t("view_full_profile")} onClose={handleClose} wide>
      {/* Cover + avatar */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ background: C.panel2 }}>
        <div className="h-20" style={{ background: `linear-gradient(135deg, ${C.greenDeep}, #0A2119)` }} />
        <div className="px-4 pb-4 -mt-8">
          <div className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold border-4"
            style={{ background: C.green, color: "#08130E", borderColor: C.panel }}>
            {(d.name || "?")[0].toUpperCase()}
          </div>
          <div className="mt-2">
            <p className="font-semibold text-lg flex items-center gap-1.5" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              {d.name} <VerifiedTick show={d.verified} />
            </p>
            <p className="text-sm" style={{ color: C.muted }}>{d.type} developer · {d.payment === "paid" ? t("paid") : t("free")}</p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <Stars value={d.rating} size={14} />
              <span className="text-xs" style={{ color: C.muted }}>{d.votes || 0} {t("rating").toLowerCase()}s</span>
              <span className="text-xs" style={{ color: C.muted }}>·</span>
              <span className="text-xs" style={{ color: C.muted }}>{d.followers || 0} {t("followers")}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button onClick={toggleFollowClick} disabled={followBusy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border"
          style={following ? { background: C.green, borderColor: C.green, color: "#08130E" } : { borderColor: C.border, color: C.text }}>
          <Bookmark size={14} fill={following ? "#08130E" : "none"} /> {following ? t("following") : t("follow")}
        </button>
        <GhostButton icon={Share2} onClick={() => { copyShareLink("developers", d.id); alert(t("link_copied")); }}>{t("share")}</GhostButton>
        {canManage && onEdit && (
          <GhostButton icon={Pencil} onClick={() => { onEdit(d); handleClose(); }}>{t("edit")}</GhostButton>
        )}
        {canManage && (
          <GhostButton icon={Trash2} onClick={() => confirmed(`Delete ${d.name}'s listing? This can't be undone.`, () => { onDelete(d); handleClose(); })}>
            {t("delete")}
          </GhostButton>
        )}
      </div>

      <div className="rounded-xl border p-4 mb-3" style={{ borderColor: C.border, background: C.panel2 }}>
        <p className="text-xs font-semibold mb-2" style={{ color: C.muted }}>{t("about_dev")}</p>
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{d.cv || "—"}</p>
      </div>

      <div className="rounded-xl border p-4 mb-3" style={{ borderColor: C.border, background: C.panel2 }}>
        <p className="text-xs font-semibold mb-2" style={{ color: C.muted }}>{t("skills_type")}</p>
        <span className="text-xs px-2.5 py-1 rounded-full" style={{ background: C.greenDeep, color: C.green }}>{d.type}</span>
        <span className="text-xs px-2.5 py-1 rounded-full ml-2" style={{ background: C.panel, color: C.muted, border: `1px solid ${C.border}` }}>
          {d.payment === "paid" ? t("paid") : t("free")}
        </span>
      </div>

      <div className="rounded-xl border p-4 mb-3" style={{ borderColor: C.border, background: C.panel2 }}>
        <p className="text-xs font-semibold mb-2" style={{ color: C.muted }}>{t("contact_info")}</p>
        <p className="text-sm break-all" style={{ color: C.text }}>{d.contact || "—"}</p>
      </div>

      <div className="rounded-xl border p-4" style={{ borderColor: C.border, background: C.panel2 }}>
        <p className="text-xs font-semibold mb-2" style={{ color: C.muted }}>{t("rating")}</p>
        {!session.loggedIn || session.banned ? (
          <p className="text-xs" style={{ color: C.muted }}>{t("login_required")}</p>
        ) : (
          <>
            <p className="text-[11px] mb-1" style={{ color: C.muted }}>{myRating ? "Your rating:" : t("rating") + ":"}</p>
            <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
              {[1, 2, 3, 4, 5].map((i) => (
                <button key={i} disabled={busy} onMouseEnter={() => setHover(i)} onClick={() => rate(i)}>
                  <Star size={22} fill={i <= (hover || myRating || 0) ? C.gold : "none"} color={i <= (hover || myRating || 0) ? C.gold : C.border} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function DevsSection({ t, session, coll, ads, openId, onConsumeOpenId }) {
  const [q, setQ] = useState(""); const [typeFilter, setTypeFilter] = useState("all"); const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [active, setActive] = useState(null);
  const flashId = useFlashHighlight(openId, coll.items.length > 0, onConsumeOpenId);
  const types = ["all", "Server", "Mod", "Plugin", "Website"];
  const visible = coll.items.filter((d) => (typeFilter === "all" ? true : d.type === typeFilter)).filter((d) => (q ? d.name.toLowerCase().includes(q.toLowerCase()) : true))
    .sort((a, b) => ((b.verified ? 1 : 0) - (a.verified ? 1 : 0)) || ((b.rating || 0) - (a.rating || 0)));

  // Open shared developer deep-link
  useEffect(() => {
    if (!openId || !coll.items.length) return;
    const match = coll.items.find((d) => d.id === openId);
    if (match) setActive(match);
    onConsumeOpenId();
  }, [openId, coll.items]);

  const save = async (f) => {
    if (editing) {
      await coll.update(editing.id, { name: f.name, type: f.type, cv: f.cv, payment: f.payment, contact: f.contact });
    } else {
      await coll.add({ ...f, rating: 0, votes: 0, followers: 0, verified: false, createdAt: Date.now(), ownerId: session.uid });
      await markPosted(session.uid);
    }
    setShowForm(false); setEditing(null);
  };
  const remove = async (itemOrId) => {
    const id = typeof itemOrId === "object" ? itemOrId.id : itemOrId;
    await coll.remove(id);
    setActive(null);
  };

  return (
    <div>
      <SectionHeader icon={Code2} title={t("nav_devs")} action={
        <PrimaryButton icon={Plus} onClick={() => guardPost(session, () => { setEditing(null); setShowForm(true); })}>{t("add_dev")}</PrimaryButton>
      } />
      <div className="relative mb-3 max-w-lg">
        <Search size={15} className="absolute left-2.5 top-3 sm:top-2.5" color={C.muted} />
        <input className={inputCls + " pl-8"} style={inputStyle} placeholder={t("search_ph")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="flex gap-2 flex-nowrap overflow-x-auto pb-1 mb-4 -mx-1 px-1">
        {types.map((tp) => <Pill key={tp} active={typeFilter === tp} onClick={() => setTypeFilter(tp)}>{tp === "all" ? t("all") : tp}</Pill>)}
      </div>
      <div className="space-y-2">
        {visible.length === 0 && <p className="text-sm" style={{ color: C.muted }}>{t("no_results")}</p>}
        {interleaveAds(visible, adsForCategory(ads.items, "devs"), 4).map((row, i) => {
          if (row.kind === "ad") return <AdSlot key={`ad-${row.data.id}-${i}`} ad={row.data} t={t} category="devs" viewerUid={session.uid} />;
          const d = row.data;
          return <DevCard key={d.id} d={d} t={t} highlighted={d.id === flashId} onOpen={setActive} />;
        })}
      </div>
      {showForm && <DevFormModal t={t} initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} />}
      {active && (
        <DevProfileModal
          d={active} t={t} session={session}
          canManage={session.loggedIn && (session.uid === active.ownerId || session.role === "admin" || session.role === "owner")}
          onClose={() => setActive(null)}
          onDelete={remove}
          onEdit={(d) => { setEditing(d); setShowForm(true); }}
        />
      )}
    </div>
  );
}

// =============================================================================
// BEST PLAYER (leaderboard, one like per account)
// =============================================================================
const RANK_COLOR = { 1: "#F0B94D", 2: "#C9CFD6", 3: "#CC8A4C" };

function PlayerFormModal({ t, servers, initial, onClose, onSave }) {
  const [f, setF] = useState(initial || { name: "", platform: "Java", desc: "", discord: "", serverId: "", photo: null });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal title={initial ? `${t("edit")} — ${t("nav_players")}` : t("add_player")} onClose={onClose}>
      <Field label={t("player_name") + " *"}><input className={inputCls} style={inputStyle} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
      <Field label={t("platform")}>
        <select className={inputCls} style={inputStyle} value={f.platform} onChange={(e) => set("platform", e.target.value)}>
          <option>Java</option><option>Bedrock</option>
        </select>
      </Field>
      <Field label={t("player_server")}>
        <select className={inputCls} style={inputStyle} value={f.serverId} onChange={(e) => set("serverId", e.target.value)}>
          <option value="">{t("none_option")}</option>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label={t("player_discord")}>
        <input className={inputCls} style={inputStyle} placeholder="username or discord.gg/…" value={f.discord || ""} onChange={(e) => set("discord", e.target.value)} />
      </Field>
      <Field label={t("player_desc")}><textarea rows={3} className={inputCls} style={inputStyle} value={f.desc} onChange={(e) => set("desc", e.target.value)} /></Field>
      <Field label={t("profile_pic")}><ImagePicker value={f.photo} onChange={(v) => set("photo", v)} /></Field>
      <SaveButton canSave={!!f.name} onSave={() => onSave(f)}>{t("save")}</SaveButton>
    </Modal>
  );
}

function PlayerDetailModal({ p, rank, t, session, servers, canManage, onClose, onEdit, onDelete }) {
  const [liked, setLiked] = useState(false);
  const [busy, setBusy] = useState(false);
  const server = servers.find((s) => s.id === p.serverId);

  useEffect(() => {
    if (!session.uid) { setLiked(false); return; }
    getMyPlayerLike(p.id, session.uid).then(setLiked).catch(() => {});
  }, [p.id, session.uid]);

  const toggle = () => guardPost(session, async () => {
    setBusy(true);
    try { setLiked(await togglePlayerLike(p.id, session.uid)); }
    catch (err) {
      console.error(err);
      alert("Couldn't save your like — " + (err?.message || "please try again."));
    } finally { setBusy(false); }
  });

  const share = () => { copyShareLink("players", p.id); alert(t("link_copied")); };
  const handleClose = () => { resetShareUrl(); onClose(); };
  const discord = (p.discord || "").trim();
  const discordIsLink = /^https?:\/\//i.test(discord) || /^discord\.gg\//i.test(discord);
  const discordHref = discordIsLink
    ? (discord.startsWith("http") ? discord : `https://${discord}`)
    : null;

  return (
    <Modal title={t("player_details")} onClose={handleClose}>
      <div className="flex flex-col items-center text-center mb-4">
        <div className="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center mb-3"
          style={{ background: C.panel2, border: rank && rank <= 3 ? `3px solid ${RANK_COLOR[rank]}` : `2px solid ${C.border}` }}>
          {p.photo ? <img src={p.photo} className="w-full h-full object-cover" alt="" /> : <User size={32} color={C.muted} />}
        </div>
        <p className="font-semibold text-lg flex items-center gap-1.5">
          {rank ? <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: rank <= 3 ? RANK_COLOR[rank] : C.panel2, color: rank <= 3 ? "#181205" : C.muted }}>#{rank}</span> : null}
          {p.name}
        </p>
        <p className="text-xs mt-1" style={{ color: C.muted }}>
          {p.platform}{server ? ` · ${server.name}` : ""}
        </p>
        <ListingBadges t={t} createdAt={p.createdAt} rating={5} votes={p.likes} trendMinVotes={10} trendMinRating={0} />
        <div className="mt-3">
          <LikeButton liked={liked} busy={busy} count={p.likes} onClick={toggle} />
        </div>
      </div>

      {p.desc ? (
        <div className="mb-4">
          <p className="text-xs font-medium mb-1" style={{ color: C.muted }}>{t("player_desc")}</p>
          <p className="text-sm whitespace-pre-wrap" style={{ color: C.text }}>{p.desc}</p>
        </div>
      ) : null}

      {discord ? (
        <div className="mb-4">
          <p className="text-xs font-medium mb-1" style={{ color: C.muted }}>{t("player_discord")}</p>
          {discordHref ? (
            <a href={discordHref} target="_blank" rel="noreferrer" className="text-sm underline break-all" style={{ color: C.green }}>{discord}</a>
          ) : (
            <p className="text-sm font-mono break-all" style={{ color: C.text }}>{discord}</p>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <GhostButton icon={Share2} onClick={share}>{t("share")}</GhostButton>
        {canManage && onEdit && <GhostButton icon={Pencil} onClick={onEdit}>{t("edit")}</GhostButton>}
        {canManage && onDelete && (
          <GhostButton icon={Trash2} onClick={() => confirmed(`Remove ${p.name} from the leaderboard? This can't be undone.`, onDelete)}>{t("delete")}</GhostButton>
        )}
      </div>
    </Modal>
  );
}

function LikeButton({ liked, busy, count, onClick }) {
  return (
    <button onClick={onClick} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border shrink-0"
      style={liked ? { background: C.red, borderColor: C.red, color: "#1A0507" } : { borderColor: C.border, color: C.text }}>
      <Heart size={13} fill={liked ? "#1A0507" : "none"} /> {count || 0}
    </button>
  );
}

function PlayerEntry({ p, rank, t, session, servers, canManage, onDelete, onEdit, onOpen, highlighted }) {
  const [liked, setLiked] = useState(false);
  const [busy, setBusy] = useState(false);
  const server = servers.find((s) => s.id === p.serverId);

  useEffect(() => {
    if (!session.uid) { setLiked(false); return; }
    getMyPlayerLike(p.id, session.uid).then(setLiked).catch(() => {});
  }, [p.id, session.uid]);

  const toggle = (e) => {
    e?.stopPropagation?.();
    guardPost(session, async () => {
      setBusy(true);
      try {
        const nowLiked = await togglePlayerLike(p.id, session.uid);
        setLiked(nowLiked);
      } catch (err) {
        console.error(err);
        alert("Couldn't save your like — " + (err?.message || "please try again."));
      } finally {
        setBusy(false);
      }
    });
  };

  const stop = (e) => e.stopPropagation();
  const podium = rank <= 3;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(p, rank)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(p, rank); } }}
      className={podium
        ? "rounded-xl border p-3 flex flex-col items-center text-center transition-shadow cursor-pointer active:opacity-90"
        : "rounded-xl border p-3 flex items-center gap-3 transition-shadow cursor-pointer active:opacity-90"}
      style={{
        borderColor: highlighted ? C.green : (podium ? RANK_COLOR[rank] : C.border),
        background: C.panel,
        boxShadow: highlighted ? `0 0 0 2px ${C.green}` : "none",
      }}
    >
      {podium ? (
        <>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold mb-1" style={{ background: RANK_COLOR[rank], color: "#181205" }}>{rank}</div>
          <div className="w-14 h-14 rounded-full overflow-hidden flex items-center justify-center mb-2" style={{ background: C.panel2, border: `2px solid ${RANK_COLOR[rank]}` }}>
            {p.photo ? <img src={p.photo} className="w-full h-full object-cover" /> : <User size={22} color={C.muted} />}
          </div>
          <p className="font-semibold text-sm truncate max-w-full">{p.name}</p>
          <p className="text-[10px] mb-1 truncate max-w-full" style={{ color: C.muted }}>{server ? server.name : p.platform}</p>
          {p.desc && <p className="text-[11px] mb-2 line-clamp-2">{p.desc}</p>}
          <LikeButton liked={liked} busy={busy} count={p.likes} onClick={toggle} />
          <div className="flex items-center gap-2 mt-2" onClick={stop}>
            <button onClick={() => { copyShareLink("players", p.id); alert(t("link_copied")); }}><Share2 size={13} color={C.muted} /></button>
            {canManage && onEdit && <button onClick={onEdit}><Pencil size={13} color={C.muted} /></button>}
            {canManage && <button onClick={() => confirmed(`Remove ${p.name} from the leaderboard? This can't be undone.`, () => onDelete(p))}><Trash2 size={13} color={C.muted} /></button>}
          </div>
        </>
      ) : (
        <>
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ background: C.panel2, color: C.muted }}>{rank}</div>
          <div className="w-9 h-9 rounded-full overflow-hidden flex items-center justify-center shrink-0" style={{ background: C.panel2 }}>
            {p.photo ? <img src={p.photo} className="w-full h-full object-cover" /> : <User size={16} color={C.muted} />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate flex items-center gap-1.5">{p.name} <ListingBadges t={t} createdAt={p.createdAt} rating={5} votes={p.likes} trendMinVotes={10} trendMinRating={0} /></p>
            <p className="text-[11px] truncate" style={{ color: C.muted }}>{server ? server.name : p.platform}</p>
          </div>
          <div onClick={stop} className="flex items-center gap-2 shrink-0">
            <LikeButton liked={liked} busy={busy} count={p.likes} onClick={toggle} />
            <button onClick={() => { copyShareLink("players", p.id); alert(t("link_copied")); }}><Share2 size={14} color={C.muted} /></button>
            {canManage && onEdit && <button onClick={onEdit}><Pencil size={14} color={C.muted} /></button>}
            {canManage && <button onClick={() => confirmed(`Remove ${p.name} from the leaderboard? This can't be undone.`, () => onDelete(p))}><Trash2 size={14} color={C.muted} /></button>}
          </div>
        </>
      )}
    </div>
  );
}

function PlayersSection({ t, session, servers, coll, ads, openId, onConsumeOpenId }) {
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [active, setActive] = useState(null); // { player, rank }
  const flashId = useFlashHighlight(openId && !active ? openId : null, coll.items.length > 0, onConsumeOpenId);

  // Shared /players/:id links open the detail modal once data is loaded.
  useEffect(() => {
    if (!openId || !coll.items.length) return;
    const match = coll.items.find((p) => p.id === openId);
    if (match) {
      const ranked = [...coll.items].sort((a, b) => (b.likes || 0) - (a.likes || 0));
      const rank = ranked.findIndex((x) => x.id === match.id) + 1;
      setActive({ player: match, rank });
    } else {
      alert("That shared player link doesn't match anything here anymore — it may have been removed.");
    }
    onConsumeOpenId();
  }, [openId, coll.items]);

  const ranked = useMemo(() => coll.items
    .filter((p) => (q ? p.name.toLowerCase().includes(q.toLowerCase()) : true))
    .sort((a, b) => (b.likes || 0) - (a.likes || 0)), [coll.items, q]);
  const podiumOrder = [ranked[1], ranked[0], ranked[2]]; // 2nd, 1st, 3rd — classic podium layout
  const rest = ranked.slice(3);

  const save = async (f) => {
    const payload = {
      name: f.name,
      platform: f.platform,
      desc: f.desc || "",
      discord: (f.discord || "").trim(),
      serverId: f.serverId || "",
      photo: f.photo || null,
    };
    if (editing) {
      await deleteReplacedImages(editing, payload);
      await coll.update(editing.id, payload);
      if (active?.player?.id === editing.id) {
        setActive({ player: { ...active.player, ...payload }, rank: active.rank });
      }
    } else {
      await coll.add({ ...payload, likes: 0, createdAt: Date.now(), ownerId: session.uid });
      await markPosted(session.uid);
    }
    setShowForm(false); setEditing(null);
  };
  const remove = async (itemOrId) => {
    const item = typeof itemOrId === "object" ? itemOrId : coll.items.find((x) => x.id === itemOrId);
    await deleteImagesFromRecord(item);
    await coll.remove(typeof itemOrId === "object" ? itemOrId.id : itemOrId);
    setActive(null);
  };

  const openPlayer = (p, rank) => setActive({ player: p, rank });
  const canManageOf = (p) => session.loggedIn && (session.uid === p.ownerId || session.role === "admin" || session.role === "owner");

  return (
    <div>
      <SectionHeader icon={Trophy} title={t("nav_players")} action={
        <PrimaryButton icon={Plus} onClick={() => guardPost(session, () => setShowForm(true))}>{t("add_player")}</PrimaryButton>
      } />
      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="absolute left-2.5 top-3 sm:top-2.5" color={C.muted} />
        <input className={inputCls + " pl-8"} style={inputStyle} placeholder={t("search_ph")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {ranked.length === 0 && <p className="text-sm" style={{ color: C.muted }}>{t("no_results")}</p>}

      {ranked.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-4 items-end">
          {podiumOrder.map((p, i) => {
            const rank = i === 1 ? 1 : i === 0 ? 2 : 3;
            if (!p) return <div key={rank} />;
            return (
              <div key={p.id} className={i === 1 ? "" : "mt-4"}>
                <PlayerEntry p={p} rank={rank} t={t} session={session} servers={servers}
                  canManage={canManageOf(p)} onDelete={remove}
                  onEdit={() => { setEditing(p); setShowForm(true); }}
                  onOpen={openPlayer} highlighted={p.id === flashId} />
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        {interleaveAds(rest, adsForCategory(ads.items, "players"), 4).map((row, i) => {
          if (row.kind === "ad") return <AdSlot key={`ad-${row.data.id}-${i}`} ad={row.data} t={t} category="players" viewerUid={session.uid} />;
          const p = row.data;
          const rank = rest.indexOf(p) + 4;
          return (
            <PlayerEntry key={p.id} p={p} rank={rank} t={t} session={session} servers={servers}
              canManage={canManageOf(p)} onDelete={remove}
              onEdit={() => { setEditing(p); setShowForm(true); }}
              onOpen={openPlayer} highlighted={p.id === flashId} />
          );
        })}
      </div>
      {showForm && <PlayerFormModal t={t} servers={servers} initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} />}
      {active && (
        <PlayerDetailModal
          p={active.player}
          rank={active.rank}
          t={t}
          session={session}
          servers={servers}
          canManage={canManageOf(active.player)}
          onClose={() => setActive(null)}
          onEdit={() => { setEditing(active.player); setShowForm(true); setActive(null); }}
          onDelete={() => remove(active.player)}
        />
      )}
    </div>
  );
}

// =============================================================================
// CONTENT CREATORS (YouTube / Facebook / Instagram / Twitch link posts)
// =============================================================================
function ContentFormModal({ t, initial, onClose, onSave }) {
  const [link, setLink] = useState(initial?.link || "");
  const [preview, setPreview] = useState(initial ? { platform: initial.platform, title: initial.title, thumbnail: initial.thumbnail } : null);
  const [err, setErr] = useState("");
  const [loadingTitle, setLoadingTitle] = useState(false);

  const refreshPreview = async (url) => {
    setLink(url);
    setErr("");
    setPreview(null);
    if (!url.trim()) return;
    setLoadingTitle(true);
    try {
      // Instant local preview (thumbnail), then upgrade title from the video itself
      try {
        setPreview(buildLinkPreview(url.trim()));
      } catch (e) {
        setErr(e.message || "Unsupported link");
        setLoadingTitle(false);
        return;
      }
      const full = await fetchLinkPreview(url.trim());
      setPreview(full);
    } catch (e) {
      setErr(e.message || "Unsupported link");
    } finally {
      setLoadingTitle(false);
    }
  };

  return (
    <Modal title={initial ? `${t("edit")} — ${t("nav_creators")}` : t("add_content")} onClose={onClose}>
      <Field label={t("content_link") + " *"}>
        <input className={inputCls} style={inputStyle} placeholder="https://youtube.com/watch?v=…" value={link}
          onChange={(e) => refreshPreview(e.target.value)} />
      </Field>
      {err && <p className="text-xs mb-2" style={{ color: C.red }}>{err}</p>}
      {preview && (
        <div className="rounded-xl border overflow-hidden mb-3" style={{ borderColor: C.border }}>
          <div className="h-36 flex items-center justify-center" style={{ background: preview.thumbnail ? `url(${preview.thumbnail}) center/cover` : C.panel2 }}>
            {!preview.thumbnail && <Film size={28} color={C.muted} />}
          </div>
          <div className="p-2">
            <p className="text-sm font-medium line-clamp-2">{loadingTitle ? "Loading title…" : preview.title}</p>
            <p className="text-[11px] capitalize mt-0.5" style={{ color: C.muted }}>{preview.platform} · {t("content_title_auto")}</p>
          </div>
        </div>
      )}
      <SaveButton canSave={!!(preview && link.trim() && !loadingTitle)} onSave={() => onSave({
        link: link.trim(),
        platform: preview.platform,
        title: preview.title,
        thumbnail: preview.thumbnail,
      })}>{t("save")}</SaveButton>
    </Modal>
  );
}

function ContentCard({ post, t, session, canManage, onDelete, onEdit, onViewProfile, highlighted }) {
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  useEffect(() => {
    if (!session.uid) { setFollowing(false); return; }
    isFollowing("content", post.id, session.uid).then(setFollowing).catch(() => {});
  }, [post.id, session.uid]);

  /** Count a view only when the user actually opens the video/post link (once per browser session). */
  const recordViewOnClick = () => {
    const key = `minebd_cv_${post.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch { /* still try to count */ }
    updateDoc(doc(db, "content", post.id), { views: increment(1) }).catch(() => {});
  };

  const toggleFollowClick = () => guardPost(session, async () => {
    setFollowBusy(true);
    try { setFollowing(await toggleFollow("content", post.id, session.uid)); }
    catch (err) { console.error(err); alert("Couldn't update follow — " + (err?.message || "please try again.")); }
    finally { setFollowBusy(false); }
  });

  const platformColor = { youtube: "#FF0000", facebook: "#1877F2", instagram: "#E4405F", twitch: "#9146FF" };

  return (
    <div className="rounded-xl border overflow-hidden transition-shadow" style={{ borderColor: highlighted ? C.green : C.border, background: C.panel, boxShadow: highlighted ? `0 0 0 2px ${C.green}` : "none" }}>
      <a href={post.link} target="_blank" rel="noreferrer" className="block" onClick={recordViewOnClick}>
        <div className="h-40 flex items-center justify-center relative" style={{ background: post.thumbnail ? `url(${post.thumbnail}) center/cover` : C.panel2 }}>
          {!post.thumbnail && <Film size={32} color={C.muted} />}
          <span className="absolute bottom-2 left-2 text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize" style={{ background: platformColor[post.platform] || C.border, color: "#fff" }}>{post.platform}</span>
        </div>
      </a>
      <div className="p-3">
        <a href={post.link} target="_blank" rel="noreferrer" onClick={recordViewOnClick} className="font-semibold text-sm mb-1 line-clamp-2 block" style={{ color: C.text }}>
          {post.title}
        </a>
        <p className="text-[10px] mb-1.5 flex items-center gap-1" style={{ color: C.muted }}><Eye size={11} /> {post.views || 0}</p>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <button onClick={() => onViewProfile(post.ownerId)} className="text-[11px]" style={{ color: C.muted }}>{t("view_profile")}</button>
          <div className="flex items-center gap-2">
            <button onClick={toggleFollowClick} disabled={followBusy} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border"
              style={following ? { background: C.green, borderColor: C.green, color: "#08130E" } : { borderColor: C.border, color: C.text }}>
              <Bookmark size={10} fill={following ? "#08130E" : "none"} /> {following ? t("following") : t("follow")}{post.followers ? ` (${post.followers})` : ""}
            </button>
            <a href={post.link} target="_blank" rel="noreferrer" onClick={recordViewOnClick}><ExternalLink size={14} color={C.muted} /></a>
            {canManage && onEdit && <button onClick={onEdit}><Pencil size={14} color={C.muted} /></button>}
            {canManage && <button onClick={() => confirmed(`Delete this post?`, onDelete)}><Trash2 size={14} color={C.muted} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CreatorsSection({ t, session, coll, ads, openId, onConsumeOpenId, onViewProfile }) {
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const flashId = useFlashHighlight(openId, coll.items.length > 0, onConsumeOpenId);
  const visible = useMemo(() => coll.items
    .filter((p) => (q ? (p.title + p.link).toLowerCase().includes(q.toLowerCase()) : true))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), [coll.items, q]);

  const save = async (f) => {
    if (editing) {
      await deleteReplacedImages(editing, f);
      await coll.update(editing.id, { link: f.link, platform: f.platform, title: f.title, thumbnail: f.thumbnail });
    } else {
      await coll.add({ ...f, followers: 0, views: 0, createdAt: Date.now(), ownerId: session.uid });
      await markPosted(session.uid);
      // Notify anyone who followed any of this creator's earlier posts about the new one.
      try {
        const prior = coll.items.filter((x) => x.ownerId === session.uid);
        const seen = new Set();
        for (const post of prior) {
          const ids = await getFollowerIds("content", post.id);
          for (const uid of ids) {
            if (seen.has(uid) || uid === session.uid) continue;
            seen.add(uid);
            await sendNotification(uid, {
              type: "content",
              message: `New content from ${session.name || "a creator"}: ${f.title}`,
              link: null,
            });
          }
        }
      } catch (err) {
        console.error("[minebd] content notify failed:", err);
      }
    }
    setShowForm(false); setEditing(null);
  };
  const remove = async (post) => {
    await deleteImagesFromRecord(post);
    await coll.remove(post.id);
  };

  return (
    <div>
      <SectionHeader icon={Film} title={t("nav_creators")} action={
        <PrimaryButton icon={Plus} onClick={() => guardPost(session, () => setShowForm(true))}>{t("add_content")}</PrimaryButton>
      } />
      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="absolute left-2.5 top-3 sm:top-2.5" color={C.muted} />
        <input className={inputCls + " pl-8"} style={inputStyle} placeholder={t("search_ph")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.length === 0 && <p className="text-sm col-span-full" style={{ color: C.muted }}>{t("no_results")}</p>}
        {interleaveAds(visible, adsForCategory(ads.items, "creators")).map((row, i) => {
          if (row.kind === "ad") return <AdSlot key={`ad-${row.data.id}-${i}`} ad={row.data} t={t} category="creators" viewerUid={session.uid} />;
          const post = row.data;
          const canManage = session.loggedIn && (session.uid === post.ownerId || session.role === "admin" || session.role === "owner");
          return (
            <ContentCard key={post.id} post={post} t={t} session={session} canManage={canManage}
              onDelete={() => remove(post)} onEdit={() => { setEditing(post); setShowForm(true); }}
              onViewProfile={onViewProfile} highlighted={post.id === flashId} />
          );
        })}
      </div>
      {showForm && <ContentFormModal t={t} initial={editing} onClose={() => { setShowForm(false); setEditing(null); }} onSave={save} />}
    </div>
  );
}


function AdFormModal({ t, onClose, onSave }) {
  const [f, setF] = useState({ img: null, link: "", days: 7, reach: "", category: "all", quality: "good" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const catLabels = {
    all: t("ad_category_all"),
    servers: t("nav_servers"), events: t("nav_events"), players: t("nav_players"),
    reports: t("nav_reports"), market: t("nav_market"), devs: t("nav_devs"), creators: t("nav_creators"),
  };
  return (
    <Modal title={t("create_ad")} onClose={onClose}>
      <Field label={t("ad_photo")}><ImagePicker value={f.img} onChange={(v) => set("img", v)} /></Field>
      <Field label={t("ad_link")}><input className={inputCls} style={inputStyle} value={f.link} onChange={(e) => set("link", e.target.value)} /></Field>
      <Field label={t("ad_category")}>
        <select className={inputCls} style={inputStyle} value={f.category} onChange={(e) => set("category", e.target.value)}>
          {AD_CATEGORIES.map((c) => <option key={c} value={c}>{catLabels[c] || c}</option>)}
        </select>
      </Field>
      <Field label="Ad quality (show frequency)">
        <select className={inputCls} style={inputStyle} value={f.quality} onChange={(e) => set("quality", e.target.value)}>
          <option value="basic">Basic — shown least often</option>
          <option value="good">Good</option>
          <option value="great">Great</option>
          <option value="premium">Premium — shown most often</option>
        </select>
      </Field>
      <p className="text-[11px] mb-3" style={{ color: C.muted }}>{t("payout_rate")}</p>
      <Field label={t("ad_days")}><input type="number" className={inputCls} style={inputStyle} value={f.days} onChange={(e) => set("days", Number(e.target.value))} /></Field>
      <Field label={t("ad_reach")}><input type="number" className={inputCls} style={inputStyle} value={f.reach} onChange={(e) => set("reach", e.target.value)} placeholder="∞" /></Field>
      <PrimaryButton full onClick={() => f.img && onSave(f)}>{t("save")}</PrimaryButton>
    </Modal>
  );
}
function UserRow({ u, t, canPromote, isOwner, onSetRole, onSetBanned, onSetVerified, onSetMonetized, onViewProfile }) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg flex-wrap" style={{ background: C.panel2 }}>
      <button onClick={() => onViewProfile(u.id)} className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] shrink-0" style={{ background: C.green, color: "#08130E" }}>{(u.name || "?")[0]}</button>
      <div className="flex-1 min-w-0">
        <button onClick={() => onViewProfile(u.id)} className="text-xs font-medium truncate flex items-center gap-1">
          {u.name} <VerifiedTick show={u.verified} />
          {u.monetized && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "#3A2410", color: C.gold }}>{t("monetized")}</span>}
          {u.banned && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: C.redDeep, color: C.red }}>banned</span>}
        </button>
        <p className="text-[10px]" style={{ color: C.muted }}>{u.role}</p>
      </div>
      <div className="flex gap-1 flex-wrap">
        {canPromote && (
          u.role === "admin"
            ? <button onClick={() => onSetRole(u.id, "member")} className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.border }}>{t("remove_admin")}</button>
            : u.role !== "owner" && <button onClick={() => onSetRole(u.id, "admin")} className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.border }}>{t("make_admin")}</button>
        )}
        {!u.verified
          ? <button onClick={() => onSetVerified(u.id, true)} className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.border }}>{t("grant_verification")}</button>
          : <button onClick={() => onSetVerified(u.id, false)} className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.border, color: C.muted }}>Revoke verification</button>}
        {isOwner && (
          <button onClick={() => onSetMonetized(u.id, !u.monetized)} className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.gold, color: C.gold }}>
            {u.monetized ? t("unmonetize") : t("monetize")}
          </button>
        )}
        {u.role !== "owner" && (
          <button
            onClick={() => u.banned ? onSetBanned(u.id, false) : confirmed(`Ban ${u.name}? They won't be able to post, vote, or review until unbanned.`, () => onSetBanned(u.id, true))}
            className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: u.banned ? C.green : C.red, color: u.banned ? C.green : C.red }}>
            {u.banned ? "Unban" : t("ban_account")}
          </button>
        )}
      </div>
    </div>
  );
}

function PublicProfileModal({ uid, t, onClose, allData }) {
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(db, "users", uid)).then((snap) => {
      if (!cancelled && snap.exists()) setProfile({ id: snap.id, ...snap.data() });
    });
    return () => { cancelled = true; };
  }, [uid]);

  if (!profile) {
    return <Modal title="Profile" onClose={onClose}><div className="py-8 flex justify-center"><Loader2 className="animate-spin" color={C.muted} /></div></Modal>;
  }

  const mine = {
    [t("nav_servers")]: allData.servers.filter((x) => x.ownerId === uid).map((x) => x.name),
    [t("nav_events")]: allData.events.filter((x) => x.ownerId === uid).map((x) => x.title),
    [t("nav_market")]: allData.resources.filter((x) => x.ownerId === uid).map((x) => x.name),
    [t("nav_devs")]: allData.developers.filter((x) => x.ownerId === uid).map((x) => x.name),
    [t("nav_players")]: allData.players.filter((x) => x.ownerId === uid).map((x) => x.name),
    [t("nav_creators")]: (allData.content || []).filter((x) => x.ownerId === uid).map((x) => x.title),
  };
  const totalPosts = Object.values(mine).reduce((sum, arr) => sum + arr.length, 0);
  const joined = profile.createdAt?.toDate ? profile.createdAt.toDate() : null;
  const totalViews = (allData.content || []).filter((x) => x.ownerId === uid).reduce((s, x) => s + (x.views || 0), 0);

  return (
    <Modal title={profile.name} onClose={onClose}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold shrink-0" style={{ background: C.green, color: "#08130E" }}>{(profile.name || "?")[0]}</div>
        <div className="min-w-0">
          <p className="font-semibold flex items-center gap-1 truncate">{profile.name} <VerifiedTick show={profile.verified} />
            {profile.monetized && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "#3A2410", color: C.gold }}>{t("monetized")}</span>}
          </p>
          {profile.role !== "member" && <p className="text-[11px] capitalize" style={{ color: C.muted }}>{profile.role}</p>}
          {joined && <p className="text-[11px]" style={{ color: C.muted }}>{t("member_since")} {joined.toLocaleDateString()}</p>}
        </div>
      </div>
      {profile.monetized && (
        <div className="mb-3">
          <p className="text-[10px] mb-1" style={{ color: C.gold }}>{t("monetization_dev")}</p>
          {(allData.ads || []).slice(0, 1).map((ad) => (
            <AdSlot key={ad.id} ad={ad} t={t} profileUid={uid} category="profile" />
          ))}
          {!(allData.ads || []).length && <p className="text-[11px]" style={{ color: C.muted }}>No ads configured yet.</p>}
          <p className="text-[10px] mt-1" style={{ color: C.muted }}>{t("estimated_payout")}: ৳{estimatePayout(totalViews)} ({totalViews.toLocaleString()} {t("your_views").toLowerCase()} · {t("payout_rate")})</p>
        </div>
      )}
      <p className="text-xs mb-4" style={{ color: C.muted }}>{t("posts_by")}: {totalPosts}</p>
      {Object.entries(mine).filter(([, list]) => list.length > 0).map(([label, list]) => (
        <div key={label} className="mb-3">
          <p className="text-xs font-medium mb-1">{label}</p>
          {list.map((name, i) => <p key={i} className="text-xs" style={{ color: C.text }}>• {name}</p>)}
        </div>
      ))}
      {totalPosts === 0 && <p className="text-xs" style={{ color: C.muted }}>No public listings yet.</p>}
    </Modal>
  );
}

function MemberMonetizationPanel({ t, session, contentItems }) {
  const myPosts = (contentItems || []).filter((c) => c.ownerId === session.uid);
  const totalViews = myPosts.reduce((s, c) => s + (c.views || 0), 0);
  const totalFollowers = myPosts.reduce((s, c) => s + (c.followers || 0), 0);
  const earnings = estimatePayout(totalViews);
  const progress = payoutProgress(totalViews);
  const enabled = !!session.monetized;

  // Simple 7-bar mock distribution of views across posts (visual graph for every account)
  const bars = myPosts.slice(0, 14).map((c) => c.views || 0);
  while (bars.length < 7) bars.push(0);
  const maxBar = Math.max(1, ...bars);

  return (
    <div className="rounded-xl border p-4 mb-4" style={{ borderColor: C.border, background: C.panel }}>
      <p className="font-semibold text-sm mb-1 flex items-center gap-1"><DollarSign size={16} color={C.gold} /> {t("monetization")}</p>
      <p className="text-[10px] mb-3" style={{ color: C.gold }}>{t("monetization_dev")}</p>
      <p className="text-xs mb-3" style={{ color: enabled ? C.green : C.muted }}>
        {enabled ? t("monetization_on") : t("monetization_off")}
      </p>
      <p className="text-[11px] mb-3" style={{ color: C.muted }}>{t("payout_rate")}</p>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="rounded-lg p-2 text-center" style={{ background: C.panel2 }}>
          <p className="text-lg font-bold">{totalViews.toLocaleString()}</p>
          <p className="text-[10px]" style={{ color: C.muted }}>{t("your_views")}</p>
        </div>
        <div className="rounded-lg p-2 text-center" style={{ background: C.panel2 }}>
          <p className="text-lg font-bold">৳{enabled ? earnings : 0}</p>
          <p className="text-[10px]" style={{ color: C.muted }}>{t("your_earnings")}</p>
        </div>
        <div className="rounded-lg p-2 text-center" style={{ background: C.panel2 }}>
          <p className="text-lg font-bold">{totalFollowers}</p>
          <p className="text-[10px]" style={{ color: C.muted }}>{t("followers")}</p>
        </div>
      </div>

      <p className="text-xs font-medium mb-1" style={{ color: C.muted }}>{t("toward_next")}</p>
      <div className="h-2 rounded-full mb-1 overflow-hidden" style={{ background: C.panel2 }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: enabled ? C.green : C.border }} />
      </div>
      <p className="text-[10px] mb-4" style={{ color: C.muted }}>{(totalViews % 100000).toLocaleString()} / 100,000</p>

      <p className="text-xs font-medium mb-2" style={{ color: C.muted }}>{t("your_views")}</p>
      <div className="flex items-end gap-1 h-16">
        {bars.slice(0, 14).map((v, i) => (
          <div key={i} className="flex-1 rounded-t-sm" title={`${v} views`}
            style={{ height: `${Math.max(4, (v / maxBar) * 100)}%`, background: enabled ? C.green : C.border, opacity: enabled ? 1 : 0.5 }} />
        ))}
      </div>
      {!enabled && (
        <p className="text-[10px] mt-3" style={{ color: C.muted }}>
          Graph is visible on every account. Earnings only unlock after the owner enables monetization for you.
        </p>
      )}
    </div>
  );
}

function AnalyticsDashboard({ t, counts, users, contentItems }) {
  const [visits, setVisits] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadVisits = async () => {
    setLoading(true);
    try { setVisits(await getRecentVisitCounts(14)); }
    catch (err) { console.error("[minebd] Could not load visit stats:", err); }
    finally { setLoading(false); }
  };

  const mostActive = [...users].filter((u) => u.postCount).sort((a, b) => (b.postCount || 0) - (a.postCount || 0)).slice(0, 5);
  // Aggregate followers on content posts by owner
  const followByOwner = {};
  (contentItems || []).forEach((c) => {
    if (!c.ownerId) return;
    followByOwner[c.ownerId] = (followByOwner[c.ownerId] || 0) + (c.followers || 0);
  });
  const mostFollowed = Object.entries(followByOwner)
    .map(([uid, followers]) => ({ uid, followers, name: users.find((u) => u.id === uid)?.name || uid.slice(0, 6) }))
    .sort((a, b) => b.followers - a.followers)
    .slice(0, 5);
  const maxVisit = visits ? Math.max(1, ...visits.map((v) => v.count)) : 1;

  return (
    <div className="rounded-xl border p-4 mb-4" style={{ borderColor: C.border, background: C.panel }}>
      <p className="font-semibold text-sm mb-3 flex items-center gap-1"><BarChart3 size={16} color={C.green} /> {t("dashboard")}</p>
      <p className="text-[10px] mb-3" style={{ color: C.gold }}>{t("monetization_dev")}</p>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {Object.entries(counts).map(([label, n]) => (
          <div key={label} className="rounded-lg p-2 text-center" style={{ background: C.panel2 }}>
            <p className="text-lg font-bold">{n}</p>
            <p className="text-[10px] capitalize" style={{ color: C.muted }}>{label}</p>
          </div>
        ))}
      </div>

      <p className="text-xs font-medium mb-2" style={{ color: C.muted }}>{t("most_active")}</p>
      <div className="space-y-1 mb-4">
        {mostActive.length === 0 && <p className="text-[11px]" style={{ color: C.muted }}>Not enough activity yet.</p>}
        {mostActive.map((u, i) => (
          <div key={u.id} className="flex items-center justify-between text-xs">
            <span>{i + 1}. {u.name}{u.monetized ? " · 💰" : ""}</span>
            <span style={{ color: C.muted }}>{u.postCount} posts</span>
          </div>
        ))}
      </div>

      <p className="text-xs font-medium mb-2" style={{ color: C.muted }}>{t("most_followers")}</p>
      <div className="space-y-1 mb-4">
        {mostFollowed.length === 0 && <p className="text-[11px]" style={{ color: C.muted }}>No content follows yet.</p>}
        {mostFollowed.map((u, i) => (
          <div key={u.uid} className="flex items-center justify-between text-xs">
            <span>{i + 1}. {u.name}</span>
            <span style={{ color: C.muted }}>{u.followers} followers</span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium" style={{ color: C.muted }}>{t("daily_active")} (14d)</p>
        <button onClick={loadVisits} disabled={loading} className="text-[10px] underline" style={{ color: C.green }}>{loading ? "…" : visits ? "Refresh" : "Load"}</button>
      </div>
      {visits && (
        <div className="flex items-end gap-1 h-16">
          {visits.map((v) => (
            <div key={v.date} className="flex-1 rounded-t-sm" title={`${v.date}: ${v.count}`}
              style={{ height: `${Math.max(4, (v.count / maxVisit) * 100)}%`, background: C.green }} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileSection({ t, session, onUpdateName, onLogin, onLogout, onDeleteAccount, adsColl, usersAdmin, counts, onViewProfile, lang, setLang, contentItems }) {
  const [name, setName] = useState(session.name || ""); const [showAdForm, setShowAdForm] = useState(false);
  const [verifyContact, setVerifyContact] = useState(""); const [verifyMethod, setVerifyMethod] = useState("phone");
  const [verifySubmitting, setVerifySubmitting] = useState(false);
  const [adStats, setAdStats] = useState({});
  const isAdmin = session.role === "owner" || session.role === "admin";
  const { requests: verificationRequests, resolveRequest } = useVerificationRequests(isAdmin);
  useEffect(() => setName(session.name || ""), [session.name]);
  useEffect(() => {
    if (session.role !== "owner" && session.role !== "admin") return;
    getAdImpressionCounts(adsColl.items.map((a) => a.id)).then(setAdStats).catch(() => {});
  }, [adsColl.items, session.role]);

  if (!session.loggedIn) {
    return (
      <div className="text-center py-16">
        <User size={40} className="mx-auto mb-3" color={C.muted} />
        <p className="mb-4 text-sm" style={{ color: C.muted }}>{t("login_required")}</p>
        <PrimaryButton icon={LogIn} onClick={onLogin}>{t("login")}</PrimaryButton>
      </div>
    );
  }

  const isOwner = session.role === "owner";
  const otherUsers = usersAdmin.users.filter((u) => u.id !== session.uid);

  return (
    <div className="max-w-lg">
      <SectionHeader icon={User} title={t("nav_profile")} />
      {session.banned && (
        <div className="rounded-xl border p-3 mb-4 text-sm" style={{ borderColor: C.red, background: C.redDeep, color: C.red }}>
          Your account has been banned. You can still browse, but you can't post, vote, or review.
        </div>
      )}
      <div className="rounded-xl border p-4 mb-4" style={{ borderColor: C.border, background: C.panel }}>
        <Field label={t("profile_name")}>
          <div className="flex gap-2">
            <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
            <PrimaryButton onClick={() => onUpdateName(name)}>{t("save")}</PrimaryButton>
          </div>
        </Field>
        <p className="text-sm flex items-center gap-1 mb-3">{session.name} <VerifiedTick show={session.verified} /> <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: C.panel2, color: C.muted }}>{session.role}</span></p>
        <div className="flex flex-wrap gap-2">
          <GhostButton icon={LogOut} onClick={onLogout}>{t("logout")}</GhostButton>
          <GhostButton icon={Trash2} onClick={onDeleteAccount}>{t("delete_account")}</GhostButton>
        </div>
      </div>

      <div className="rounded-xl border p-4 mb-4" style={{ borderColor: C.border, background: C.panel }}>
        <Field label={t("language")}>
          <button onClick={() => setLang(lang === "en" ? "bn" : "en")} className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border" style={{ borderColor: C.border }}>
            <Globe size={15} /> {lang === "en" ? "বাংলা" : "English"}
          </button>
        </Field>
      </div>

      {!session.verified && (
        <div className="rounded-xl border p-4 mb-4" style={{ borderColor: C.border, background: "#241D0E" }}>
          <p className="text-sm font-medium mb-1 flex items-center gap-1"><ShieldCheck size={16} color={C.gold} /> {t("apply_verification")}</p>
          <p className="text-xs mb-2" style={{ color: C.muted }}>{t("verification_note")}</p>
          <Field label={t("contact_method")}>
            <div className="flex gap-2 flex-wrap">
              <Pill active={verifyMethod === "phone"} onClick={() => setVerifyMethod("phone")}>Phone</Pill>
              <Pill active={verifyMethod === "email"} onClick={() => setVerifyMethod("email")}>Email</Pill>
              <Pill active={verifyMethod === "discord"} onClick={() => setVerifyMethod("discord")}>Discord</Pill>
            </div>
          </Field>
          <input className={inputCls} style={{ ...inputStyle, marginBottom: 8 }} value={verifyContact} onChange={(e) => setVerifyContact(e.target.value)}
            placeholder={verifyMethod === "phone" ? "+8801XXXXXXXXX" : verifyMethod === "email" ? "you@example.com" : "username#0000 or discord.gg/…"} />
          <PrimaryButton disabled={verifySubmitting} onClick={async () => {
            if (!verifyContact.trim()) { alert("Please enter a contact so admins can reach you."); return; }
            setVerifySubmitting(true);
            try {
              await submitVerificationRequest(session.uid, session.name, verifyMethod, verifyContact.trim());
              alert("Verification request submitted — an admin will review it and reach out.");
              setVerifyContact("");
            } catch (err) {
              console.error(err);
              alert("Couldn't submit your request — " + (err?.message || "please try again."));
            } finally {
              setVerifySubmitting(false);
            }
          }}>{verifySubmitting ? "…" : t("submit")}</PrimaryButton>
        </div>
      )}

      <MemberMonetizationPanel t={t} session={session} contentItems={contentItems} />

      {isAdmin && (
        <div className="rounded-xl border p-4 mb-4" style={{ borderColor: C.border, background: C.panel }}>
          <p className="font-semibold text-sm mb-3 flex items-center gap-1">
            {isOwner ? <Crown size={16} color={C.gold} /> : <ShieldAlert size={16} color={C.red} />}
            {isOwner ? t("owner_panel") : t("admin_panel")}
          </p>
          <p className="text-[11px] mb-2" style={{ color: C.muted }}>
            Delete buttons for admins/owner now show up directly on servers, events, reports, market listings, and developer profiles — no need to hunt them down here.
          </p>
          <AnalyticsDashboard t={t} counts={counts} users={usersAdmin.users} contentItems={contentItems} />

          <div className="mb-4">
            <p className="text-xs font-medium mb-2" style={{ color: C.muted }}>Verification requests{verificationRequests.filter((r) => r.status === "pending").length ? ` (${verificationRequests.filter((r) => r.status === "pending").length} pending)` : ""}</p>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {verificationRequests.filter((r) => r.status === "pending").length === 0 && (
                <p className="text-[11px]" style={{ color: C.muted }}>No pending requests.</p>
              )}
              {verificationRequests.filter((r) => r.status === "pending").map((req) => (
                <div key={req.id} className="flex items-center gap-2 p-2 rounded-lg flex-wrap" style={{ background: C.panel2 }}>
                  <div className="flex-1 min-w-0 text-xs">
                    <button onClick={() => onViewProfile(req.uid)} className="font-medium">{req.name}</button>
                    <p className="text-[10px]" style={{ color: C.muted }}>{req.method}: {req.contact}</p>
                  </div>
                  <button onClick={() => { usersAdmin.setVerified(req.uid, true); resolveRequest(req.id, "approved"); }}
                    className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.green, color: C.green }}>Approve</button>
                  <button onClick={() => resolveRequest(req.id, "dismissed")}
                    className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.border, color: C.muted }}>Dismiss</button>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-2 mb-3 max-h-64 overflow-y-auto pr-1">
            {otherUsers.length === 0 && <p className="text-xs" style={{ color: C.muted }}>No other members yet.</p>}
            {otherUsers.map((u) => (
              <UserRow key={u.id} u={u} t={t} canPromote={isOwner} isOwner={isOwner} onViewProfile={onViewProfile}
                onSetRole={usersAdmin.setRole} onSetBanned={usersAdmin.setBanned} onSetVerified={usersAdmin.setVerified}
                onSetMonetized={usersAdmin.setMonetized} />
            ))}
          </div>
          {isOwner && (
            <>
              <p className="text-[11px] mb-2 px-2 py-1.5 rounded" style={{ background: "#241D0E", color: C.gold }}>{t("monetization_dev")}</p>
              <PrimaryButton icon={Megaphone} onClick={() => setShowAdForm(true)}>{t("create_ad")}</PrimaryButton>
              <p className="text-[11px] mt-2 mb-2" style={{ color: C.muted }}>{t("active_ads")}: {adsColl.items.length}</p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {adsColl.items.map((ad) => (
                  <div key={ad.id} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: C.panel2 }}>
                    <div className="w-12 h-8 rounded overflow-hidden shrink-0" style={{ background: C.border }}>
                      {ad.img && <img src={ad.img} className="w-full h-full object-cover" alt="" />}
                    </div>
                    <div className="flex-1 min-w-0 text-[10px]" style={{ color: C.muted }}>
                      <p className="truncate">{ad.category || "all"} · {ad.quality || "good"}</p>
                      <p className="flex items-center gap-1"><Eye size={10} /> {adStats[ad.id] ?? "…"} {t("ad_impressions")}</p>
                    </div>
                    <button onClick={() => confirmed("Delete this ad?", async () => { await deleteImagesFromRecord(ad); await adsColl.remove(ad.id); })} className="text-[10px] px-2 py-1 rounded border" style={{ borderColor: C.red, color: C.red }}>{t("delete_ad")}</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {showAdForm && <AdFormModal t={t} onClose={() => setShowAdForm(false)} onSave={async (f) => { await adsColl.add({ ...f, served: 0, createdAt: Date.now() }); setShowAdForm(false); }} />}
    </div>
  );
}

// =============================================================================
// APP SHELL
// =============================================================================
function NotificationBell({ t, session }) {
  const { items, unreadCount, markAllRead, clear } = useNotifications(session.uid);
  const [open, setOpen] = useState(false);
  if (!session.loggedIn) return null;

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative p-2 rounded-lg" style={{ background: C.panel2 }}>
        <Bell size={15} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center" style={{ background: C.red, color: "#1A0507" }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-72 max-h-96 overflow-y-auto rounded-xl border shadow-xl z-50" style={{ background: C.panel, borderColor: C.border }}>
            <div className="flex items-center justify-between px-3 py-2 border-b sticky top-0" style={{ borderColor: C.border, background: C.panel }}>
              <span className="text-xs font-semibold">{t("notifications")}</span>
              {unreadCount > 0 && <button onClick={markAllRead} className="text-[10px]" style={{ color: C.green }}>{t("mark_all_read")}</button>}
            </div>
            {items.length === 0 && <p className="text-xs p-3" style={{ color: C.muted }}>{t("no_notifications")}</p>}
            {items.map((n) => (
              <div key={n.id} className="px-3 py-2 border-b text-xs flex items-start justify-between gap-2" style={{ borderColor: C.border, background: n.read ? "transparent" : C.panel2 }}>
                <span className="flex-1">{n.message}</span>
                <button onClick={() => clear(n.id)} className="shrink-0"><X size={12} color={C.muted} /></button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState("en");
  const t = (k) => LANG[lang][k] || k;
  const bnFont = lang === "bn" ? "'Noto Sans Bengali', sans-serif" : "'Inter', sans-serif";

  const [authUser, setAuthUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [deepLink, setDeepLink] = useState(getDeepLinkFromPath);
  const [tab, setTab] = useState(() => (deepLink ? (TAB_FOR_SHARE_TYPE[deepLink.type] || "servers") : "servers"));
  const openIdFor = (type) => (deepLink?.type === type ? deepLink.id : null);
  const consumeDeepLink = () => setDeepLink(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => { setAuthUser(u); setAuthReady(true); });
  }, []);

  // Real role/verified/banned live in Firestore (users/{uid}), not in local
  // state — that's what makes the admin/owner panel actually enforce
  // anything instead of just changing what this one browser tab believes.
  const { user: userDoc, updateName } = useUserDoc(authUser?.uid, authUser?.displayName);
  const session = useMemo(() => ({
    loggedIn: !!authUser,
    uid: authUser?.uid || null,
    name: userDoc?.name || authUser?.displayName || "",
    verified: !!userDoc?.verified,
    role: userDoc?.role || "member",
    banned: !!userDoc?.banned,
    monetized: !!userDoc?.monetized,
  }), [authUser, userDoc]);

  const handleLogin = async () => {
    try { await signInWithPopup(auth, googleProvider); }
    catch (e) { console.error(e); alert("Sign-in failed — please try again."); }
  };
  const handleLogout = async () => { await signOut(auth); };

  /**
   * Deletes the person's users/{uid} profile doc, then their Firebase Auth
   * account. Firebase requires a *recent* sign-in for account deletion; if
   * it's been a while, we re-prompt the Google sign-in popup once and retry
   * instead of just failing with a cryptic error.
   */
  const handleDeleteAccount = async () => {
    if (!window.confirm("Permanently delete your account? This removes your profile and can't be undone.")) return;
    try {
      if (authUser?.uid) {
        await deleteDoc(doc(db, "users", authUser.uid)).catch((err) => {
          // Not fatal — the auth account deletion below is the important part.
          console.error("[minebd] Could not delete profile doc:", err);
        });
      }
      await deleteUser(auth.currentUser);
      alert("Your account has been deleted.");
    } catch (err) {
      if (err?.code === "auth/requires-recent-login") {
        try {
          await signInWithPopup(auth, googleProvider);
          await deleteUser(auth.currentUser);
          alert("Your account has been deleted.");
        } catch (err2) {
          console.error("[minebd] Account deletion failed after re-auth:", err2);
          alert("Couldn't delete your account — " + (err2?.message || "please try again."));
        }
      } else {
        console.error("[minebd] Account deletion failed:", err);
        alert("Couldn't delete your account — " + (err?.message || "please try again."));
      }
    }
  };

  const serversColl = useFirestoreCollection("servers");
  const eventsColl = useFirestoreCollection("events");
  const reportsColl = useFirestoreCollection("reports");
  const resourcesColl = useFirestoreCollection("resources");
  const devsColl = useFirestoreCollection("developers");
  const adsColl = useFirestoreCollection("ads");
  const playersColl = useFirestoreCollection("players");
  const contentColl = useFirestoreCollection("content");
  const usersAdmin = useAllUsers();
  const [viewProfileUid, setViewProfileUid] = useState(null);

  // Unique-daily-active-user bookkeeping for the admin dashboard.
  useEffect(() => { if (session.uid) logDailyVisit(session.uid); }, [session.uid]);

  const counts = {
    [t("nav_servers")]: serversColl.items.length,
    [t("nav_events")]: eventsColl.items.length,
    [t("nav_players")]: playersColl.items.length,
    [t("nav_creators")]: contentColl.items.length,
    [t("nav_reports")]: reportsColl.items.length,
    [t("nav_market")]: resourcesColl.items.length,
    [t("nav_devs")]: devsColl.items.length,
  };

  const NAV = [
    { id: "servers", label: t("nav_servers"), icon: ServerIcon },
    { id: "events", label: t("nav_events"), icon: Calendar },
    { id: "players", label: t("nav_players"), icon: Trophy },
    { id: "creators", label: t("nav_creators"), icon: Film },
    { id: "reports", label: t("nav_reports"), icon: Flag },
    { id: "market", label: t("nav_market"), icon: Package },
    { id: "devs", label: t("nav_devs"), icon: Code2 },
    { id: "profile", label: t("nav_profile"), icon: User },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: bnFont, color: C.text }}>
      <header className="sticky top-0 z-40 border-b" style={{ background: "rgba(23,27,30,0.92)", borderColor: C.border, backdropFilter: "blur(6px)" }}>
        <div className="max-w-6xl mx-auto px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center font-bold text-sm shrink-0" style={{ background: C.green, color: "#08130E", fontFamily: "'Space Grotesk', sans-serif" }}>
              <img src="/logo.png" alt="MineBD" className="w-full h-full object-cover"
                onError={(e) => { e.currentTarget.style.display = "none"; e.currentTarget.parentElement.textContent = "MB"; }} />
            </div>
            <div className="min-w-0">
              <p className="font-bold leading-none text-sm truncate" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{t("brand")}</p>
              <p className="text-[10px] truncate" style={{ color: C.muted }}>{t("tagline")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <NotificationBell t={t} session={session} />
            {session.loggedIn ? (
              <button onClick={() => setTab("profile")} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg" style={{ background: C.panel2 }}>
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: C.green, color: "#08130E" }}>{(session.name || "?")[0]}</div>
                <span className="hidden sm:inline">{session.name}</span> <VerifiedTick show={session.verified} />
              </button>
            ) : (
              <PrimaryButton icon={LogIn} onClick={handleLogin}>{t("login")}</PrimaryButton>
            )}
          </div>
        </div>
        <nav className="max-w-6xl mx-auto px-3 sm:px-4 pb-2 flex gap-1 overflow-x-auto">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setTab(n.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap"
              style={tab === n.id ? { background: C.green, color: "#08130E" } : { color: C.text }}>
              <n.icon size={14} /> {n.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-3 sm:px-4 py-6">
        {!authReady ? (
          <div className="flex items-center justify-center py-24"><Loader2 className="animate-spin" color={C.muted} /></div>
        ) : (
          <>
            {tab === "servers" && <ServersSection t={t} session={session} coll={serversColl} ads={adsColl} openId={openIdFor("servers")} onConsumeOpenId={consumeDeepLink} onViewProfile={setViewProfileUid} />}
            {tab === "events" && <EventsSection t={t} session={session} servers={serversColl.items} coll={eventsColl} ads={adsColl} openId={openIdFor("events")} onConsumeOpenId={consumeDeepLink} />}
            {tab === "players" && <PlayersSection t={t} session={session} servers={serversColl.items} coll={playersColl} ads={adsColl} openId={openIdFor("players")} onConsumeOpenId={consumeDeepLink} />}
            {tab === "creators" && <CreatorsSection t={t} session={session} coll={contentColl} ads={adsColl} openId={openIdFor("content")} onConsumeOpenId={consumeDeepLink} onViewProfile={setViewProfileUid} />}
            {tab === "reports" && <ReportsSection t={t} session={session} coll={reportsColl} ads={adsColl} />}
            {tab === "market" && <MarketSection t={t} session={session} coll={resourcesColl} ads={adsColl} openId={openIdFor("resources")} onConsumeOpenId={consumeDeepLink} />}
            {tab === "devs" && <DevsSection t={t} session={session} coll={devsColl} ads={adsColl} openId={openIdFor("developers")} onConsumeOpenId={consumeDeepLink} />}
            {tab === "profile" && <ProfileSection t={t} session={session} onUpdateName={updateName} onLogin={handleLogin} onLogout={handleLogout} onDeleteAccount={handleDeleteAccount} adsColl={adsColl} usersAdmin={usersAdmin} counts={counts} onViewProfile={setViewProfileUid} lang={lang} setLang={setLang} contentItems={contentColl.items} />}
          </>
        )}
      </main>
      <footer className="text-center text-[11px] py-6 space-y-1.5 max-w-xl mx-auto px-3" style={{ color: C.muted }}>
        <p className="font-medium" style={{ color: C.text }}>{t("brand")} — {t("tagline")}</p>
        <p>{t("about_blurb")}</p>
        <p>{t("made_by")}</p>
        <p>{t("support")}: <a href="mailto:info.minebd@proton.me" className="underline" style={{ color: C.green }}>info.minebd@proton.me</a></p>
      </footer>
      {viewProfileUid && (
        <PublicProfileModal
          uid={viewProfileUid} t={t} onClose={() => setViewProfileUid(null)}
          allData={{ servers: serversColl.items, events: eventsColl.items, resources: resourcesColl.items, developers: devsColl.items, players: playersColl.items, content: contentColl.items, ads: adsColl.items }}
        />
      )}
    </div>
  );
}
