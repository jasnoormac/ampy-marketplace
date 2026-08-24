// lib/craigslistDraft.js
//
// Craigslist cross-posting helper for seller listings.
//
// Craigslist has no public posting API, and automating its posting form
// (stored logins, CAPTCHA, phone verification) is exactly the road this
// app refuses elsewhere — see the extension rationale in
// lib/extensionBridge.js and the 403 notes in lib/craigslistFetcher.js.
// So "post to Craigslist" here means: build a posting-ready draft from
// the listing and hand the seller a link to Craigslist's own posting
// flow, where they paste it and hit publish in their own session.

const craigslistLocations = require("../data/craigslistLocations.js");

const CRAIGSLIST_LOCATION = process.env.CRAIGSLIST_LOCATION || "sfbay";

const KNOWN_SLUGS = new Set(craigslistLocations.map((l) => l.slug));

function locationName(slug) {
  return craigslistLocations.find((l) => l.slug === slug)?.name || slug;
}

// Craigslist's sfbay flow asks for a sub-area ("peninsula", "east bay",
// ...). Approximate it from the seller's ZIP so the extension can
// pre-select the radio. Other metros: null — the seller picks by hand.
function sfbaySubArea(postal) {
  const zip = String(postal || "");
  if (!/^9\d{4}$/.test(zip)) return null;
  const n = Number(zip);
  if (n >= 95001 && n <= 95077) return "santa cruz";
  const byPrefix = {
    "941": "san francisco",
    "940": "peninsula", "943": "peninsula", "944": "peninsula",
    "945": "east bay", "946": "east bay", "947": "east bay", "948": "east bay",
    "949": "north bay",
    "950": "south bay", "951": "south bay",
  };
  return byPrefix[zip.slice(0, 3)] || null;
}

// Ampy category -> the for-sale-by-owner category Craigslist's posting
// flow asks the seller to pick. Human-readable labels, not CL's internal
// abbreviations, because the seller matches them against a radio list.
const CATEGORY_MAP = {
  electronics: "electronics - by owner",
  furniture: "furniture - by owner",
  vehicles: "cars & trucks - by owner",
  appliances: "appliances - by owner",
  instruments: "musical instruments - by owner",
  "sporting goods": "sporting goods - by owner",
  general: "general for sale - by owner",
};

/**
 * Build a Craigslist-ready draft for a just-published seller listing.
 *
 * @param {object} listing - canonical listing from lib/listingStore.js
 * @returns {{postUrl: string, location: string, category: string,
 *            postingTitle: string, price: number, body: string,
 *            draftText: string}}
 */
// Absolute URL a browser (the extension, inside a craigslist.org page)
// can fetch a listing photo from. Relative /uploads/ paths are served by
// this same buyer process.
const BUYER_ORIGIN = `http://127.0.0.1:${process.env.PORT || 3001}`;

function absoluteImageUrls(listing) {
  return (listing.images || [])
    .filter((url) => typeof url === "string" && url)
    .map((url) => (url.startsWith("http") ? url : `${BUYER_ORIGIN}${url}`));
}

function buildDraft(listing) {
  // Per-listing market (chosen in the seller form) wins over the env
  // default; unknown slugs fall back rather than 404ing on Craigslist.
  const slug = KNOWN_SLUGS.has(listing.craigslistLocation) ? listing.craigslistLocation : CRAIGSLIST_LOCATION;
  const category = CATEGORY_MAP[listing.category] || CATEGORY_MAP.general;
  const postingTitle = listing.title;
  const price = listing.price;

  const bodyParts = [];
  if (listing.description) bodyParts.push(listing.description);
  if (listing.condition && listing.condition !== "unknown") {
    bodyParts.push(`Condition: ${listing.condition}`);
  }
  const body = bodyParts.join("\n\n");

  // One block the UI can put on the clipboard, ordered the way
  // Craigslist's form asks for the fields.
  const draftText = [
    `Posting title: ${postingTitle}`,
    `Price: $${price}`,
    `Category: ${category}`,
    "",
    body,
  ].join("\n");

  return {
    // /fso enters Craigslist's own "for sale by owner" deep link — their
    // URL, so the posting-type page is skipped legitimately.
    postUrl: `https://post.craigslist.org/c/${slug}/fso`,
    location: slug,
    locationName: locationName(slug),
    postal: listing.postal || null,
    subArea: slug === "sfbay" ? sfbaySubArea(listing.postal) : null,
    condition: listing.condition && listing.condition !== "unknown" ? listing.condition : null,
    // Contact email for Craigslist's reply options — set
    // CRAIGSLIST_CONTACT_EMAIL in the root .env. Only ever filled into
    // the posting form in the user's own browser.
    contactEmail: process.env.CRAIGSLIST_CONTACT_EMAIL || null,
    category,
    postingTitle,
    price,
    body,
    draftText,
    imageUrls: absoluteImageUrls(listing),
  };
}

module.exports = { buildDraft };
