// Uploadcare public key (safe to expose client-side — this is how their
// direct/base upload API is designed to be used).
export const UPLOADCARE_PUBLIC_KEY = "60b3952aaa6dfd04aedc";

// Secret key is required to *delete* files via the REST API.
// Get it from Uploadcare dashboard → your project → API keys.
// Prefer a small Cloud Function / Pages Function in production so the secret
// is not shipped to browsers. Leave empty to skip remote deletes (Firestore
// docs still delete either way).
export const UPLOADCARE_SECRET_KEY = "a12a282264a0d85b4afb";

// Uploadcare accounts created after Sept 4, 2025 deliver files from a
// personal subdomain (Project settings → Delivery) instead of the legacy
// shared ucarecdn.com domain. Using the wrong domain is exactly what causes
// "broken image" icons even though the upload itself succeeded.
// Find yours at https://app.uploadcare.com/projects/-/api/ under "Delivery".
const CDN_BASE = "4298bk59oi.ucarecd.net";

/** UUID pattern used in Uploadcare CDN URLs. */
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Uploads an already-compressed image blob to Uploadcare and returns a
 * ready-to-use CDN URL with resize/quality/format operators applied, so
 * the browser always fetches a small, web-optimized version.
 */
export async function uploadImage(blob, filename = "image.jpg") {
  const form = new FormData();
  form.append("UPLOADCARE_PUB_KEY", UPLOADCARE_PUBLIC_KEY);
  form.append("UPLOADCARE_STORE", "auto");
  form.append("file", blob, filename);

  const res = await fetch("https://upload.uploadcare.com/base/", {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new Error("Uploadcare upload failed: " + res.status);
  }

  const data = await res.json();
  const uuid = data.file;

  // -/resize/ caps max width, -/quality/lighter/ + -/format/auto/ keep
  // bandwidth small automatically on top of the client-side compression.
  return `https://${CDN_BASE}/${uuid}/-/resize/900x/-/quality/lighter/-/format/auto/`;
}

/**
 * Extract an Uploadcare file UUID from a CDN URL (or return the string if
 * it is already a bare UUID). Returns null if nothing matches.
 */
export function extractUploadcareUuid(urlOrUuid) {
  if (!urlOrUuid || typeof urlOrUuid !== "string") return null;
  const m = urlOrUuid.match(UUID_RE);
  return m ? m[1] : null;
}

/**
 * True when the URL points at our Uploadcare CDN (not an external thumb
 * such as a YouTube preview).
 */
export function isUploadcareUrl(url) {
  if (!url || typeof url !== "string") return false;
  return (
    url.includes(CDN_BASE) ||
    url.includes("ucarecdn.com") ||
    url.includes("ucarecd.net")
  );
}

/**
 * Delete a single file from Uploadcare by CDN URL or UUID.
 * No-ops (resolves) when the secret key is missing, the URL is not ours,
 * or the remote call fails — so callers can always await this safely
 * before removing the Firestore document.
 */
export async function deleteImage(urlOrUuid) {
  if (!urlOrUuid) return false;
  if (!isUploadcareUrl(urlOrUuid) && !UUID_RE.test(urlOrUuid)) return false;

  const uuid = extractUploadcareUuid(urlOrUuid);
  if (!uuid) return false;

  if (!UPLOADCARE_SECRET_KEY) {
    console.warn(
      "[minebd] Uploadcare secret key not set — file not deleted from CDN.",
      "Add UPLOADCARE_SECRET_KEY in src/lib/uploadcare.js (or proxy deletes through a backend)."
    );
    return false;
  }

  try {
    const res = await fetch(`https://api.uploadcare.com/files/${uuid}/`, {
      method: "DELETE",
      headers: {
        Authorization: `Uploadcare.Simple ${UPLOADCARE_PUBLIC_KEY}:${UPLOADCARE_SECRET_KEY}`,
        Accept: "application/vnd.uploadcare-v0.7+json",
      },
    });
    // 200 / 204 = deleted; 404 = already gone — both fine for our purposes.
    if (res.ok || res.status === 404) return true;
    console.warn("[minebd] Uploadcare delete failed:", res.status, await res.text().catch(() => ""));
    return false;
  } catch (err) {
    // CORS or network — never block the Firestore delete.
    console.warn("[minebd] Uploadcare delete request failed:", err?.message || err);
    return false;
  }
}

/** Common image field names used across MineBD listings. */
const IMAGE_FIELDS = ["banner", "avatar", "photo", "proof", "img", "thumbnail"];

/**
 * Best-effort: delete every Uploadcare image attached to a listing/ad
 * document. Safe to call with partial / null records.
 */
export async function deleteImagesFromRecord(record) {
  if (!record || typeof record !== "object") return;
  const urls = IMAGE_FIELDS.map((k) => record[k]).filter(Boolean);
  if (Array.isArray(record._imageUrls)) urls.push(...record._imageUrls);
  await Promise.all(urls.map((u) => deleteImage(u).catch(() => false)));
}

/**
 * When an edit replaces an image, delete the previous Uploadcare file so
 * storage does not accumulate orphans.
 */
export async function deleteReplacedImages(oldRecord, newData, fields = IMAGE_FIELDS) {
  if (!oldRecord || !newData) return;
  const jobs = [];
  for (const field of fields) {
    const prev = oldRecord[field];
    const next = newData[field];
    if (prev && next && prev !== next && isUploadcareUrl(prev)) {
      jobs.push(deleteImage(prev).catch(() => false));
    }
  }
  await Promise.all(jobs);
}
