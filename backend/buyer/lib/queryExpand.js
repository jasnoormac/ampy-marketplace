// lib/queryExpand.js
//
// Retry queries for a Craigslist search that returned nothing. The common
// causes: non-US product names ("honda jazz" is sold here as the Honda
// Fit), over-specific phrasing, or a year token sellers didn't type.
//
// Two tiers, tried in order by the caller:
//   1. Mistral rewrites the query into up to 3 US-marketplace equivalents
//      (cheap, only runs on the zero-result path, cached per query).
//   2. Mechanical relaxation — drop year tokens, then trailing tokens —
//      which needs no API key and catches the over-specific case.

const llm = require("./llm.js");
const { tokenize } = require("./textMatch.js");

const EXPANSION_SCHEMA = {
  type: "object",
  properties: {
    queries: { type: "array", items: { type: "string" } },
  },
  required: ["queries"],
};

// Query -> alternates. Small and process-lifetime; expansion of the same
// failing query shouldn't cost a model call twice.
const cache = new Map();
const CACHE_MAX = 500;

async function llmAlternates(query) {
  try {
    const out = await llm.chatJSON({
      maxTokens: 256,
      schema: EXPANSION_SCHEMA,
      system:
        "You rewrite failed searches for US Craigslist. Given a query that returned zero results, " +
        "produce up to 3 alternative keyword queries whose words would actually appear in a US " +
        "seller's listing for the same product. Convert international product/model names to their " +
        "US-market equivalents (e.g. a car sold under a different name in the US). Prefer fewer, " +
        "more essential words; drop years unless the year is essential to the product. Order from " +
        "most to least specific. Never substitute a different product.",
      user: `Search query with zero results: "${query}"`,
    });
    return (out.queries || [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    // No API key, rate limit, bad output — expansion is best-effort.
    return [];
  }
}

function mechanicalAlternates(query) {
  const tokens = tokenize(query);
  if (tokens.length < 2) return [];
  const alternates = [];
  const withoutYears = tokens.filter((t) => !/^(19|20)\d{2}$/.test(t));
  if (withoutYears.length && withoutYears.length < tokens.length) {
    alternates.push(withoutYears.join(" "));
  }
  alternates.push(tokens.slice(0, -1).join(" "));
  if (tokens.length > 2) alternates.push(tokens.slice(0, 2).join(" "));
  return alternates;
}

/**
 * Alternate queries to retry after `query` found nothing, best first,
 * deduped, never including the original.
 */
async function alternatesFor(query) {
  const key = String(query || "").trim().toLowerCase();
  if (!key) return [];
  if (cache.has(key)) return cache.get(key);

  const combined = [...(await llmAlternates(key)), ...mechanicalAlternates(key)];
  const unique = [...new Set(combined)].filter((alt) => alt && alt !== key);

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, unique);
  return unique;
}

module.exports = { alternatesFor };
