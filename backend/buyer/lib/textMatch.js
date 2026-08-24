// lib/textMatch.js
//
// Keyword matching for GET /api/search. Replaces the old exact-phrase
// substring filter, which required the user's entire query to appear
// verbatim in a title/description — "honda fit 2011" matched nothing even
// when Craigslist returned a page of 2011 Honda Fits, because no title
// contains that contiguous phrase.
//
// Matching here is token-based: split the query into words, count how
// many appear in each listing (title hits weigh double), keep listings
// that hit enough of them, and expose a 0..1 `_textScore` that lib/rank.js
// blends into relevance ordering.

// Filler words that carry no product signal. Deliberately short — words
// like "new" or "pro" change what product is meant, so they stay.
const STOPWORDS = new Set([
  "a", "an", "the", "for", "of", "in", "on", "at", "with", "and", "or",
  "to", "my", "me", "i", "im", "want", "wanted", "need", "buy", "buying",
  "looking", "find", "please", "some", "any",
]);

function tokenize(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && (token.length > 1 || /\d/.test(token)))
    .filter((token) => !STOPWORDS.has(token));
}

function depluralize(token) {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

// A token counts as present if it (or its singular form) appears anywhere
// in the text. Substring containment is intentional: "xm5" should hit
// "WH-1000XM5" and "fit" should hit "Fit's".
function tokenInText(text, token) {
  if (text.includes(token)) return true;
  const singular = depluralize(token);
  return singular !== token && text.includes(singular);
}

/**
 * @returns {{hits: number, score: number}} hits = distinct tokens found;
 *   score = weighted (title 2, description 1), max 2 * tokens.length
 */
function scoreListing(listing, tokens) {
  const title = String(listing.title || "").toLowerCase();
  const description = String(listing.description || "").toLowerCase();
  let hits = 0;
  let score = 0;
  for (const token of tokens) {
    if (tokenInText(title, token)) {
      hits += 1;
      score += 2;
    } else if (tokenInText(description, token)) {
      hits += 1;
      score += 1;
    }
  }
  return { hits, score };
}

/**
 * Filter listings against a query and attach `_textScore` (0..1).
 *
 * Listings the `isTrusted` predicate accepts are always kept — used for
 * live Craigslist results, which Craigslist's own search already matched
 * against the query (often on text we never fetched, so a local token
 * miss proves nothing). Everything else must hit at least `keepRatio` of
 * the query's tokens.
 *
 * @param {object[]} listings
 * @param {string} query
 * @param {{isTrusted?: (l: object) => boolean, keepRatio?: number}} [opts]
 * @returns {object[]} kept listings, each with `_textScore`
 */
function filterByQuery(listings, query, { isTrusted = () => false, keepRatio = 0.6 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return listings;
  const minHits = Math.max(1, Math.ceil(tokens.length * keepRatio));
  const maxScore = tokens.length * 2;

  const kept = [];
  for (const listing of listings) {
    const { hits, score } = scoreListing(listing, tokens);
    if (hits >= minHits || isTrusted(listing)) {
      kept.push({ ...listing, _textScore: Number((score / maxScore).toFixed(4)) });
    }
  }
  return kept;
}

module.exports = { tokenize, scoreListing, filterByQuery };
