// lib/listingStore.js
//
// Storage for seller-published listings and their traction stats
// (views / inquiries).
//
// NOTE: this is a flat JSON file, read/written wholesale on every mutation.
// That's fine for a demo with a handful of listings and no concurrent
// writers, but it will NOT scale or hold up under concurrent access —
// swap this for a real database (Postgres, SQLite, etc.) before launch.
// The function signatures below are intentionally small and storage-agnostic
// so that swap should mostly be a drop-in replacement of this one file.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_PATH = path.join(__dirname, "..", "data", "sellerListings.json");

function readAll() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.warn("[listingStore] failed to read store, starting empty:", err.message);
    return [];
  }
}

function writeAll(listings) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(listings, null, 2));
}

/**
 * @param {object} fields - listing fields from the seller's (possibly edited) draft
 * @returns {object} the created listing, in the canonical Listing shape plus traction fields
 */
function createListing(fields) {
  const listings = readAll();
  const id = `seller-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const listing = {
    id,
    category: fields.category || "general",
    title: fields.title,
    price: Number(fields.price),
    condition: fields.condition || "unknown",
    distanceMiles: fields.distanceMiles ?? null,
    location: fields.location || "",
    postedAt: now,
    sellerName: fields.sellerName || null,
    // Craigslist market slug the seller picked when publishing — drives
    // the cross-post draft/extension flow (lib/craigslistDraft.js).
    craigslistLocation: fields.craigslistLocation || undefined,
    // ZIP the seller ships/sells from — Craigslist's form requires one.
    postal: fields.postal || undefined,
    sellerRating: null, // no seller review system yet
    description: fields.description || "",
    imageUrl: fields.imageUrl || null,
    // All uploaded photos; imageUrl above is the cover (first). Falls
    // back to wrapping imageUrl for callers that still send just one.
    images: Array.isArray(fields.images) && fields.images.length ? fields.images : fields.imageUrl ? [fields.imageUrl] : [],
    source: "seller",
    // Optional — the seller's real hidden floor. If set, lib/negotiate.js
    // treats it as ground truth for this listing's negotiations instead of
    // asking Mistral to estimate one. Never shown to buyers.
    minAcceptablePrice:
      fields.minAcceptablePrice != null && fields.minAcceptablePrice !== ""
        ? Number(fields.minAcceptablePrice)
        : undefined,
    // Optional — how the seller agent should negotiate on this listing's
    // behalf ('balanced' | 'firm' | 'flexible'). See lib/negotiate.js.
    negotiationStyle: fields.negotiationStyle || undefined,
    traction: { views: 0, inquiries: 0 },
    // Snapshot of the vision-detected draft this listing started from, if
    // any — kept for reference/debugging, not shown to buyers.
    detectedFrom: fields.detectedFrom || null,
    // Set by lib/repostScheduler.js when a low-traction notification was
    // last sent, so the weekly job doesn't re-notify the same listing
    // every run — see NOTIFY_COOLDOWN_DAYS there.
    lastNotifiedAt: null,
  };

  listings.push(listing);
  writeAll(listings);
  return listing;
}

function listAll() {
  return readAll();
}

function getById(id) {
  return readAll().find((l) => l.id === id) || null;
}

function recordView(id) {
  const listings = readAll();
  const listing = listings.find((l) => l.id === id);
  if (!listing) return null;
  listing.traction.views += 1;
  writeAll(listings);
  return listing;
}

function recordInquiry(id) {
  const listings = readAll();
  const listing = listings.find((l) => l.id === id);
  if (!listing) return null;
  listing.traction.inquiries += 1;
  writeAll(listings);
  return listing;
}

/** Bumps a listing's postedAt to now — the "repost" action from a Telegram low-traction alert. */
function repost(id) {
  const listings = readAll();
  const listing = listings.find((l) => l.id === id);
  if (!listing) return null;
  listing.postedAt = new Date().toISOString();
  writeAll(listings);
  return listing;
}

/** Cuts price by `percent` (rounded to the nearest dollar) — the "drop price" action from a Telegram low-traction alert. */
function dropPrice(id, percent) {
  const listings = readAll();
  const listing = listings.find((l) => l.id === id);
  if (!listing) return null;
  listing.price = Math.max(1, Math.round(listing.price * (1 - percent / 100)));
  writeAll(listings);
  return listing;
}

/** Records that a low-traction notification was just sent, so the next scheduled run's cooldown check can skip it. */
function markNotified(id) {
  const listings = readAll();
  const listing = listings.find((l) => l.id === id);
  if (!listing) return null;
  listing.lastNotifiedAt = new Date().toISOString();
  writeAll(listings);
  return listing;
}

module.exports = {
  createListing,
  listAll,
  getById,
  recordView,
  recordInquiry,
  repost,
  dropPrice,
  markNotified,
};
