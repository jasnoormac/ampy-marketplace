"use client";

import * as React from "react";
import { CheckCircle2, ExternalLink, Loader2, MapPin, Receipt, Rocket, ShoppingBag, Sparkles, X } from "lucide-react";

import { NegotiationChat, isAbort, wait } from "@/components/negotiation-chat";
import { PromptInputBox } from "@/components/ui/ai-prompt-box";
import { ampyApi } from "@/lib/ampy";
import type { Product } from "@/lib/products";
import { MAX_PURCHASE_ROUNDS, formatUsd, parsePrice, roundPrice, runPurchaseTurn, type PurchaseLine, type PurchaseReceipt } from "@/lib/purchase";
import { cn, titleCaseLocation } from "@/lib/utils";

const NEGOTIATION_MS = 30_000;
const CHECKOUT_STEPS = [
  { label: "Locking in the agreed price with the seller agent", ms: 800 },
  { label: "Checking the price against your budget", ms: 600 },
  { label: "Charging saved card •••• 4242 (simulated)", ms: 1000 },
  { label: "Order confirmed", ms: 500 },
];

interface Turn {
  id: string;
  role: "user" | "agent";
  text: string;
  products?: Product[];
  receipt?: PurchaseReceipt;
}

const PLACEHOLDER_IMAGE = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#ffffff"/><rect x="55" y="70" width="90" height="60" rx="8" fill="#e5e7eb"/><circle cx="80" cy="92" r="8" fill="#9ca3af"/><path d="M65 122l25-25 20 18 12-10 23 17z" fill="#9ca3af"/></svg>',
);

interface CraigslistListing {
  id?: string;
  title?: string;
  price?: number | null;
  url?: string;
  imageUrl?: string | null;
  location?: string;
  description?: string;
  source?: string;
}

/** The existing Craigslist scraper in backend/buyer (also folds in items you listed as a seller). */
async function searchMarketplace(query: string, location: string, signal: AbortSignal): Promise<{ message: string; products: Product[] }> {
  const budget = query.match(/(?:under|max|below)\s*\$?\s*(\d+)/i);
  const cleaned = query.replace(/(?:under|max|below)\s*\$?\s*\d+/i, "").trim() || query;
  const params = new URLSearchParams({ q: cleaned, limit: "60" });
  if (location) params.set("location", location);
  if (budget) params.set("maxPrice", budget[1]);
  const response = await fetch(`${ampyApi.buyer.search}?${params.toString()}`, { signal });
  const payload = await response.json().catch(() => ({})) as { listings?: CraigslistListing[]; total?: number; source?: string; usedMockData?: boolean; craigslistWarning?: string; effectiveQuery?: string; error?: string };
  if (!response.ok) throw new Error(payload.error || "Marketplace search failed. Is the buyer backend running on :3001?");
  const products = (payload.listings || []).flatMap((listing, index): Product[] => {
    if (!listing.title) return [];
    const own = listing.source === "seller";
    return [{
      id: String(listing.id || `${index}-${listing.title}`),
      name: listing.title,
      price: typeof listing.price === "number" ? `$${listing.price}` : "Check price",
      imageUrl: listing.imageUrl || PLACEHOLDER_IMAGE,
      productUrl: listing.url || "#",
      retailer: own ? "Ampy marketplace" : `Craigslist${listing.location ? ` · ${listing.location}` : ""}`,
      reason: (listing.description || "").replace(/\s+/g, " ").trim().slice(0, 400),
    }];
  });
  if (!products.length) throw new Error("No listings matched. Try different words.");
  const where = payload.usedMockData ? "demo listings (Craigslist unavailable)" : "Craigslist";
  const rewritten = payload.effectiveQuery ? ` — searched as “${payload.effectiveQuery}”` : "";
  const total = typeof payload.total === "number" ? payload.total : products.length;
  const count = total > products.length
    ? `Found ${total} listings on ${where} — showing the top ${products.length}`
    : `Found ${products.length} listing${products.length === 1 ? "" : "s"} on ${where}`;
  return { message: `${count}${rewritten}.`, products };
}

/** Buyer: search (existing Craigslist scraper) → pick a product → deploy your buying agent → it negotiates → simulated purchase. */
export function BuyerSection(): React.ReactElement {
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [location, setLocation] = React.useState("");
  const [locations, setLocations] = React.useState<{ slug: string; name: string; state: string }[]>([]);
  const [isRunning, setIsRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Product | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (selected) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRunning(false);
  }, []);

  const handlePurchased = React.useCallback((receipt: PurchaseReceipt) => {
    setTurns((prev) => [...prev, {
      id: crypto.randomUUID(),
      role: "agent",
      text: `Bought ${receipt.name} from ${receipt.retailer} for ${formatUsd(receipt.finalPrice)} (simulated)${receipt.saved > 0 ? ` — saved ${formatUsd(receipt.saved)} off the ${formatUsd(receipt.listPrice)} list price` : ""} in ${receipt.rounds} round${receipt.rounds === 1 ? "" : "s"}.`,
      receipt,
    }]);
  }, []);

  const handleSend = React.useCallback(async (message: string) => {
    const query = message.trim();
    if (!query || isRunning) return;
    setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text: query }]);
    setError(null);
    setSelected(null);
    setIsRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await searchMarketplace(query, location, controller.signal);
      setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: "agent", text: `${result.message} Tap one to see it and buy it.`, products: result.products }]);
    } catch (runError: unknown) {
      if (isAbort(runError)) setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: "agent", text: "Stopped." }]);
      else setError(runError instanceof Error ? runError.message : "Product search failed.");
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  }, [isRunning, location]);

  // Craigslist market list + the server's default region for the location
  // picker. US-only, like the reseller dropdown.
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/craigslist-locations")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { locations?: { region: string; slug: string; name: string; state: string }[]; default?: string } | null) => {
        if (cancelled || !data) return;
        setLocations((data.locations || []).filter((item) => item.region === "US" && item.slug && item.state));
        if (data.default) setLocation((prev) => prev || data.default!);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const locationsByState = React.useMemo(() => {
    const groups = new Map<string, { slug: string; name: string; state: string }[]>();
    for (const item of locations) {
      const group = groups.get(item.state) ?? [];
      group.push(item);
      groups.set(item.state, group);
    }
    return Array.from(groups.entries());
  }, [locations]);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-8" aria-labelledby="buyer-heading">
      <header className="text-center">
        <h2 id="buyer-heading" className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">Tell me what to buy.</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/55 sm:text-base">
          I search Craigslist and the Ampy marketplace. Pick a product, set your budget, and deploy your buying agent — it negotiates with the seller agent and buys.
        </p>
      </header>

      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2">
        <label className="flex h-10 items-center gap-2 self-start rounded-full border border-white/10 bg-white/5 px-4 text-xs text-white/70">
          <MapPin className="size-3.5 shrink-0 text-orange-300" />
          <span className="sr-only">Craigslist location</span>
          <select value={location} onChange={(event) => setLocation(event.target.value)} className="bg-transparent pr-1 text-xs font-medium text-white outline-none">
            {locations.length === 0 ? <option value="" className="bg-[#141418]">loading locations…</option> : null}
            {locationsByState.map(([state, markets]) => (
              <optgroup key={state} label={state} className="bg-[#141418]">
                {markets.map((item) => <option key={item.slug} value={item.slug} className="bg-[#141418]">{titleCaseLocation(item.name)}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <PromptInputBox onSend={handleSend} onStop={stop} isLoading={isRunning} showModes={false} placeholder="What do you want to buy?" />
      </div>

      <div aria-live="polite" className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        {turns.map((turn) => <TurnCard key={turn.id} turn={turn} selectedId={selected?.id ?? null} onSelect={setSelected} />)}
        {isRunning ? (
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
            <Sparkles className="size-4 animate-pulse text-orange-300" /> Scraping Craigslist listings…
          </div>
        ) : null}
        {error ? <div role="alert" className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div> : null}
      </div>

      {selected ? (
        <div ref={panelRef} className="mx-auto w-full max-w-[720px]">
          <BuyPanel key={selected.id} product={selected} onClose={() => setSelected(null)} onPurchased={handlePurchased} />
        </div>
      ) : null}
    </section>
  );
}

function TurnCard({ turn, selectedId, onSelect }: { turn: Turn; selectedId: string | null; onSelect: (product: Product) => void }): React.ReactElement {
  if (turn.role === "user") return <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-white px-4 py-2.5 text-sm text-[#17171b]">{turn.text}</div>;
  return (
    <div className="flex max-w-full flex-col gap-3">
      <div className="flex max-w-[90%] items-start gap-2 rounded-2xl rounded-bl-md border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white/80">
        <Sparkles className="mt-0.5 size-4 text-orange-300" />
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-white/35">{turn.receipt ? "Buying agent" : "Marketplace search"}</p>
          <p>{turn.text}</p>
        </div>
      </div>
      {turn.products?.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {turn.products.map((product) => (
            <button
              key={product.id}
              type="button"
              data-testid="product-card"
              onClick={() => onSelect(product)}
              aria-label={`Select ${product.name}`}
              aria-pressed={selectedId === product.id}
              className={cn("group overflow-hidden rounded-2xl border bg-[#19191e] text-left transition-transform duration-300 hover:-translate-y-1 focus-visible:outline-none", selectedId === product.id ? "border-orange-400" : "border-white/10 hover:border-orange-400/50")}
            >
              <div className="aspect-square overflow-hidden bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={product.imageUrl} alt={product.name} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-105" />
              </div>
              <div className="p-3">
                <p className="line-clamp-2 min-h-10 text-sm font-medium leading-5 text-white/90">{product.name}</p>
                <p className="mt-2 truncate text-xs text-white/40">{product.retailer}</p>
                <p className="mt-0.5 text-sm font-semibold text-white">{product.price}</p>
              </div>
            </button>
          ))}
        </div>
      ) : null}
      {turn.receipt ? (
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-500/5 p-3">
          <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={turn.receipt.imageUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-emerald-300/80"><Receipt className="size-3.5" /> Order {turn.receipt.orderId} · simulated</p>
            <p className="mt-1 line-clamp-1 text-sm font-medium text-white/90">{turn.receipt.name}</p>
            <p className="mt-0.5 text-xs text-white/45">{turn.receipt.retailer} · paid <span className="font-semibold text-emerald-300">{formatUsd(turn.receipt.finalPrice)}</span>{turn.receipt.saved > 0 ? <> · list <span className="line-through">{formatUsd(turn.receipt.listPrice)}</span></> : null}</p>
          </div>
          <a href={turn.receipt.productUrl} target="_blank" rel="noopener noreferrer" aria-label="Open product page" className="text-white/35 hover:text-white"><ExternalLink className="size-4" /></a>
        </div>
      ) : null}
    </div>
  );
}

type Stage = "detail" | "negotiating" | "no_deal" | "checkout" | "receipt";

function BuyPanel({ product, onClose, onPurchased }: { product: Product; onClose: () => void; onPurchased: (receipt: PurchaseReceipt) => void }): React.ReactElement {
  const parsedPrice = React.useMemo(() => parsePrice(product.price), [product.price]);
  const [stage, setStage] = React.useState<Stage>("detail");
  const [listPriceInput, setListPriceInput] = React.useState(parsedPrice ? String(parsedPrice) : "");
  const [budgetInput, setBudgetInput] = React.useState(parsedPrice ? String(parsedPrice) : "");
  const [lines, setLines] = React.useState<PurchaseLine[]>([]);
  const [typing, setTyping] = React.useState<"buyer" | "seller" | null>(null);
  const [round, setRound] = React.useState(0);
  const [sourcesNote, setSourcesNote] = React.useState<string | null>(null);
  const [lastSellerPrice, setLastSellerPrice] = React.useState<number | null>(null);
  const [deal, setDeal] = React.useState<{ price: number; rounds: number } | null>(null);
  const [checkoutStep, setCheckoutStep] = React.useState(0);
  const [receipt, setReceipt] = React.useState<PurchaseReceipt | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const reportedRef = React.useRef(false);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const listPrice = Number(listPriceInput);
  const budget = Number(budgetInput);
  const inputsValid = Number.isFinite(listPrice) && listPrice > 0 && Number.isFinite(budget) && budget > 0;

  const checkout = React.useCallback(async (purchase: { price: number; rounds: number }, signal: AbortSignal) => {
    setDeal(purchase);
    setStage("checkout");
    for (let index = 0; index < CHECKOUT_STEPS.length; index += 1) {
      setCheckoutStep(index);
      await wait(CHECKOUT_STEPS[index].ms, signal);
    }
    const done: PurchaseReceipt = {
      orderId: `AMPY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      productId: product.id,
      name: product.name,
      retailer: product.retailer,
      productUrl: product.productUrl,
      imageUrl: product.imageUrl,
      listPrice,
      finalPrice: purchase.price,
      saved: Math.max(0, roundPrice(listPrice - purchase.price, listPrice)),
      rounds: purchase.rounds,
      purchasedAt: new Date().toISOString(),
      simulated: true,
    };
    setReceipt(done);
    setStage("receipt");
    if (!reportedRef.current) {
      reportedRef.current = true;
      onPurchased(done);
    }
  }, [listPrice, onPurchased, product]);

  const run = React.useCallback(async (task: (signal: AbortSignal) => Promise<void>, fallback: Stage) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    try {
      await task(controller.signal);
    } catch (runError: unknown) {
      if (isAbort(runError)) return;
      setTyping(null);
      setError(runError instanceof Error ? runError.message : "Something went wrong.");
      setStage(fallback);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const deploy = React.useCallback(() => {
    if (!inputsValid) return setError("Enter the listed price and your budget.");
    setLines([]);
    setLastSellerPrice(null);
    setStage("negotiating");
    void run(async (signal) => {
      const started = Date.now();
      const deadline = started + NEGOTIATION_MS;
      const history: PurchaseLine[] = [];
      let lastPrice: number | null = null;
      {
        for (let current = 1; current <= MAX_PURCHASE_ROUNDS && Date.now() < deadline; current += 1) {
          setRound(current);
          setTyping("buyer");
          await wait(500, signal);
          const result = await runPurchaseTurn(
            { product: { id: product.id, name: product.name, price: product.price, retailer: product.retailer, reason: product.reason, productUrl: product.productUrl }, listPrice, budget, round: current, history },
            signal,
          );
          setSourcesNote(`your agent: ${result.sources.buyer === "mistral" ? "Mistral" : "local fallback"} · seller agent: ${result.sources.seller === "seller-agent" ? "Ampy seller service" : result.sources.seller === "local" ? "local fallback" : "—"}`);
          history.push({ role: "buyer", text: result.buyer.text, price: result.buyer.price });
          setLines([...history]);
          if (result.outcome === "deal" && !result.seller) {
            setTyping(null);
            return checkout({ price: result.dealPrice ?? result.buyer.price, rounds: current }, signal);
          }
          if (!result.seller) continue;
          setTyping("seller");
          await wait(700, signal);
          history.push({ role: "seller", text: result.seller.text, price: result.seller.price ?? undefined });
          setLines([...history]);
          if (typeof result.seller.price === "number") {
            lastPrice = result.seller.price;
            setLastSellerPrice(lastPrice);
          }
          if (result.outcome === "deal") {
            setTyping(null);
            return checkout({ price: result.dealPrice ?? result.buyer.price, rounds: current }, signal);
          }
          if (result.outcome === "no_deal") break;
        }
        setTyping(null);
        // Budget window closed (or rounds exhausted): take the seller's last price if it fits the budget.
        if (lastPrice != null && lastPrice <= budget) {
          history.push({ role: "buyer", text: `Alright — $${lastPrice} works, let's close it.`, price: lastPrice });
          setLines([...history]);
          return checkout({ price: lastPrice, rounds: history.filter((line) => line.role === "buyer").length }, signal);
        }
        setStage("no_deal");
      }
    }, "no_deal");
  }, [budget, checkout, inputsValid, listPrice, product, run]);

  const buyAnyway = React.useCallback(() => {
    const price = lastSellerPrice ?? listPrice;
    void run((signal) => checkout({ price, rounds: Math.max(round, 1) }, signal), "no_deal");
  }, [checkout, lastSellerPrice, listPrice, round, run]);

  return (
    <div className="flex flex-col overflow-hidden rounded-3xl border border-orange-400/30 bg-[#141418]" data-testid="buy-panel">
      <div className="flex items-start gap-4 border-b border-white/10 p-4">
        <div className="size-28 shrink-0 overflow-hidden rounded-2xl bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={product.imageUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-base font-semibold leading-5">{product.name}</p>
          <p className="mt-1 text-sm text-white/55">{product.retailer} · <span className="font-semibold text-white">{product.price}</span></p>
          {product.reason ? <p className="mt-2 line-clamp-3 text-xs leading-5 text-white/50">{product.reason}</p> : null}
          {product.productUrl !== "#" ? <a href={product.productUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-white/45 hover:text-white">View listing <ExternalLink className="size-3" /></a> : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="flex size-8 shrink-0 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"><X className="size-4" /></button>
      </div>

      {stage === "detail" ? (
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-white/55">Listed price (USD)
              <input type="number" min={1} step="0.01" inputMode="decimal" value={listPriceInput} onChange={(event) => setListPriceInput(event.target.value)} className="h-10 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white outline-none focus:border-orange-400/60" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/55">Your budget (USD) — hard ceiling
              <input type="number" min={1} step="0.01" inputMode="decimal" value={budgetInput} onChange={(event) => setBudgetInput(event.target.value)} className="h-10 rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-white outline-none focus:border-orange-400/60" />
            </label>
          </div>
          {!parsedPrice ? <p className="text-xs text-amber-200/80">The page didn&apos;t show a clear price — enter it to continue.</p> : null}
          {error ? <p role="alert" className="text-xs text-red-300">{error}</p> : null}
          <button type="button" onClick={deploy} disabled={!inputsValid} className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-orange-500 px-5 text-sm font-medium text-white hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-50">
            <Rocket className="size-4" /> Deploy my buying agent
          </button>
        </div>
      ) : null}

      {stage === "negotiating" || stage === "no_deal" ? (
        <NegotiationChat
          lines={lines}
          typing={typing}
          mine="buyer"
          labels={{ buyer: "Your buying agent", seller: `Seller agent · ${product.retailer}` }}
          round={round}
          maxRounds={MAX_PURCHASE_ROUNDS}
          sourcesNote={sourcesNote}
          footer={stage === "no_deal" ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-white/80">{error ? error : lastSellerPrice != null ? `No deal inside your ${formatUsd(budget)} budget — the seller agent's last price was ${formatUsd(lastSellerPrice)}.` : "The seller agent walked away."}</p>
              <div className="flex flex-wrap gap-2">
                {lastSellerPrice != null ? <button type="button" onClick={buyAnyway} className="inline-flex h-9 items-center gap-2 rounded-full bg-orange-500 px-4 text-sm font-medium text-white hover:bg-orange-400"><ShoppingBag className="size-4" /> Buy at {formatUsd(lastSellerPrice)} anyway</button> : null}
                <button type="button" onClick={deploy} className="inline-flex h-9 items-center rounded-full border border-white/15 px-4 text-sm text-white/75 hover:bg-white/5">Deploy again</button>
              </div>
            </div>
          ) : (
            <p className="text-center text-[11px] text-white/50">Budget {formatUsd(budget)} is a hard ceiling — your agent cannot go above it.</p>
          )}
        />
      ) : null}

      {stage === "checkout" && deal ? (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-base font-semibold">Buying at {formatUsd(deal.price)}…</p>
          <ol className="space-y-2">
            {CHECKOUT_STEPS.map((item, index) => (
              <li key={item.label} className={cn("flex items-center gap-2 text-sm", index < checkoutStep ? "text-emerald-300" : index === checkoutStep ? "text-white" : "text-white/35")}>
                {index < checkoutStep ? <CheckCircle2 className="size-4" /> : index === checkoutStep ? <Loader2 className="size-4 animate-spin" /> : <span className="inline-block size-4 rounded-full border border-white/20" />}
                {item.label}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {stage === "receipt" && receipt ? (
        <div className="flex flex-col gap-3 p-4" data-testid="purchase-receipt">
          <p className="flex items-center gap-2 text-base font-semibold"><CheckCircle2 className="size-5 text-emerald-400" /> Bought it — order {receipt.orderId}</p>
          <p className="text-sm text-white/70">Paid <span className="font-semibold text-emerald-300">{formatUsd(receipt.finalPrice)}</span> (list <span className="line-through">{formatUsd(receipt.listPrice)}</span>) after {receipt.rounds} round{receipt.rounds === 1 ? "" : "s"}. Simulated — no payment taken, nothing ordered.</p>
          <button type="button" onClick={onClose} className="inline-flex h-10 w-fit items-center rounded-full bg-white px-4 text-sm font-medium text-[#17171b] hover:bg-white/90">Done</button>
        </div>
      ) : null}
    </div>
  );
}
