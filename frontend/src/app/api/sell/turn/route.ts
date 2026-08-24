import { NextResponse } from "next/server";

import { buyerContext, buyerDecision, readLines, sellerBoundsDecision, type Line } from "@/lib/server/agents";

/**
 * One round of a SALE on the Ampy marketplace: a buyer agent (Mistral, with
 * its own persona budget) makes an offer on the user's listing, and the
 * user's seller agent (the Python seller service, holding the user's real
 * upper/lower bounds) answers. The client drives rounds so every bubble
 * renders as it lands — same pattern as /api/purchase/turn, other side of
 * the table. Nothing here moves real money.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_SELL_ROUNDS = 6;

interface SellTurnInput {
  item: { id: string; name: string; description: string };
  listPrice: number;
  floorPrice: number;
  budget: number;
  round: number;
  history: Line[];
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => null) as unknown;
  const input = readInput(body);
  if (!input) return NextResponse.json({ error: "Invalid sell turn." }, { status: 400 });

  const ctx = buyerContext({
    item: { id: input.item.id, name: input.item.name, description: input.item.description, retailer: "the seller" },
    listPrice: input.listPrice,
    budget: input.budget,
    round: input.round,
    maxRounds: MAX_SELL_ROUNDS,
    history: input.history,
  });

  const buyer = await buyerDecision(ctx);
  if (buyer.accept) {
    return NextResponse.json({
      buyer: { text: buyer.text, price: ctx.lastSellerPrice, accepted: true },
      seller: null,
      outcome: "deal",
      dealPrice: ctx.lastSellerPrice,
      sources: { buyer: buyer.source, seller: "none" },
    });
  }

  const seller = await sellerBoundsDecision({
    item: { id: input.item.id, name: input.item.name, description: input.item.description },
    listPrice: input.listPrice,
    floorPrice: input.floorPrice,
    round: input.round,
    history: [...input.history, { role: "buyer", text: buyer.text, price: buyer.price }],
    buyerMessage: buyer.text,
  });

  const outcome = seller.accepted
    ? "deal"
    : seller.walkAway || input.round >= MAX_SELL_ROUNDS
      ? "no_deal"
      : "continue";

  return NextResponse.json({
    buyer: { text: buyer.text, price: buyer.price, accepted: false },
    seller: { text: seller.text, price: seller.price, accepted: seller.accepted, walkAway: seller.walkAway },
    outcome,
    dealPrice: seller.accepted ? buyer.price : null,
    sources: { buyer: buyer.source, seller: seller.source },
  });
}

function readInput(body: unknown): SellTurnInput | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const item = raw.item as Record<string, unknown> | undefined;
  const listPrice = Number(raw.listPrice);
  const floorPrice = Number(raw.floorPrice);
  const budget = Number(raw.budget);
  const round = Number(raw.round);
  if (!item || typeof item.name !== "string" || !item.name.trim()) return null;
  if (!Number.isFinite(listPrice) || listPrice <= 0) return null;
  if (!Number.isFinite(floorPrice) || floorPrice <= 0 || floorPrice > listPrice) return null;
  if (!Number.isFinite(budget) || budget <= 0) return null;
  if (!Number.isInteger(round) || round < 1 || round > MAX_SELL_ROUNDS) return null;
  return {
    item: {
      id: typeof item.id === "string" ? item.id : "listing",
      name: item.name.trim().slice(0, 500),
      description: typeof item.description === "string" ? item.description.slice(0, 1000) : "",
    },
    listPrice,
    floorPrice,
    budget,
    round,
    history: readLines(raw.history),
  };
}
