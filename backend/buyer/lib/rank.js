// lib/rank.js
//
// Ranks listings by a blend of price, distance, and recency. Used by
// GET /api/search regardless of which source(s) the listings came from.

function normalize(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return () => 0.5; // neutral when nothing to compare against
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return () => 0.5;
  return (v) => (typeof v === "number" && Number.isFinite(v) ? (v - min) / (max - min) : 0.5);
}

/**
 * @param {object[]} listings
 * @param {object} [weights] - relative weights for price/distance/recency (lower price/distance is better; more recent is better)
 * @returns {object[]} listings sorted best-first, each with a `_score` (0-1, higher is better)
 */
function rankListings(listings, weights = { price: 0.3, distance: 0.15, recency: 0.2, text: 0.35 }) {
  const priceNorm = normalize(listings.map((l) => l.price));
  const distanceNorm = normalize(listings.map((l) => l.distanceMiles));
  const now = Date.now();
  const ageNorm = normalize(
    listings.map((l) => (l.postedAt ? now - new Date(l.postedAt).getTime() : null))
  );

  const scored = listings.map((listing) => {
    const priceScore = 1 - priceNorm(listing.price); // cheaper = higher score
    const distanceScore = 1 - distanceNorm(listing.distanceMiles); // closer = higher score
    const age = listing.postedAt ? now - new Date(listing.postedAt).getTime() : null;
    const recencyScore = 1 - ageNorm(age); // newer = higher score

    // _textScore comes from lib/textMatch.js when the search had a text
    // query; 0.5 is neutral so unqueried browsing ranks as before.
    const textScore = typeof listing._textScore === "number" ? listing._textScore : 0.5;

    const score =
      weights.price * priceScore +
      weights.distance * distanceScore +
      weights.recency * recencyScore +
      (weights.text || 0) * textScore;

    return { ...listing, _score: Number(score.toFixed(4)) };
  });

  return scored.sort((a, b) => b._score - a._score);
}

// Sort-mode comparators for GET /api/search ?sort=. Each
// treats an unknown value (null price/date/distance — common for
// craigslist listings before they're enriched, or listings missing a
// field entirely) as worse than any known value, so listings with real
// data always surface above listings we simply don't have data for,
// regardless of sort direction.
function nullsLast(getValue, { ascending }) {
  return (a, b) => {
    const av = getValue(a);
    const bv = getValue(b);
    const aKnown = typeof av === "number" && Number.isFinite(av);
    const bKnown = typeof bv === "number" && Number.isFinite(bv);
    if (!aKnown && !bKnown) return 0;
    if (!aKnown) return 1;
    if (!bKnown) return -1;
    return ascending ? av - bv : bv - av;
  };
}

const SORT_COMPARATORS = {
  price_asc: nullsLast((l) => l.price, { ascending: true }),
  price_desc: nullsLast((l) => l.price, { ascending: false }),
  date_desc: nullsLast((l) => (l.postedAt ? new Date(l.postedAt).getTime() : null), { ascending: false }),
  date_asc: nullsLast((l) => (l.postedAt ? new Date(l.postedAt).getTime() : null), { ascending: true }),
  distance_asc: nullsLast((l) => l.distanceMiles, { ascending: true }),
};

/**
 * Rank listings by relevance (see rankListings) and then, if a specific
 * `sort` mode was requested, re-order by that instead. Relevance's blended
 * `_score` is always computed and attached either way, so switching back
 * to "Relevance" doesn't need a second pass.
 *
 * @param {object[]} listings
 * @param {string} [sort] - 'relevance' (default) | 'price_asc' | 'price_desc' | 'date_desc' | 'date_asc' | 'distance_asc'
 * @returns {object[]}
 */
function sortListings(listings, sort = "relevance") {
  const ranked = rankListings(listings);
  const comparator = SORT_COMPARATORS[sort];
  return comparator ? [...ranked].sort(comparator) : ranked;
}

module.exports = { rankListings, sortListings };
