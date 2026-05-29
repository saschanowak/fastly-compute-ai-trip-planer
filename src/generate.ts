/// <reference types="@fastly/js-compute" />
import { env } from 'fastly:env';
import { SecretStore } from "fastly:secret-store";
import { KVStore } from "fastly:kv-store";
import { GoogleGenAI } from "@google/genai";
import { enrich } from "./enrich";
import type { Message, Checklist, TripPlanV2 } from "./types";

const SYSTEM_PROMPT = `Build a complete, MULTI-LEG trip plan from the collected key data.

Input: conversation history + checklist. Fill missing fields with reasonable assumptions that fit the requested style.

Steps:
1. Divide the trip into 2–4 legs (cities/regions) and distribute the days sensibly.
   Mentioned must-see stops must be included.
2. Set the start/end date of each leg (YYYY-MM-DD), contiguous with no gaps.
3. For each leg, generate a plausible hotel stub matching the city and travel style.
   Include: name, stars, area, 2–3 relevant badges, rationale (1 sentence).
   Set pricePerNightFrom to "Loading…" and currency to "EUR", bookingUrl to "".
   Do NOT call any tools — live prices load separately via a dedicated endpoint.
4. For outboundFlight and inboundFlight, generate plausible stubs:
   realistic airline name, correct IATA codes for origin and destination cities,
   estimated departure/arrival times, realistic durationLabel, stops (0 or 1), cabin class.
   Set priceTotal to "Loading…" and bookingUrl to "".
   Do NOT call any tools — live prices load separately via a dedicated endpoint.
5. Generate transfers between legs (mode: "car" | "transfer" | "flight").
6. Generate a title and 1–4 "experiences" per day, all in English. Each experience:
   title, description (1 sentence), category ("Beach"|"Temple"|"Golf"|"Beach Club"|"Cuisine"|
   "Water Sports"|...), imageQuery (English, for image search, e.g. "Uluwatu cliff temple sunset").
7. Write a short rationale sentence in English for each hotel, explaining why it fits.

IMPORTANT:
- Do NOT output image URLs for days/experiences or weather data — that is added downstream. Only provide imageQuery + category.
- heroImages must be an empty array [] — it will be filled in downstream.
- All user-visible text in English.
- Trip title in the style "14-Day Bali Luxury & Golf Adventure".
- Reply exclusively with valid JSON following the schema.`;

const FLIGHT_SEGMENT_SCHEMA = {
  type: "object" as const,
  properties: {
    from: { type: "string" as const },
    to: { type: "string" as const },
    airline: { type: "string" as const },
    airlineLogoUrl: { type: "string" as const, nullable: true },
    departTime: { type: "string" as const },
    arriveTime: { type: "string" as const },
    durationLabel: { type: "string" as const },
    stops: { type: "number" as const },
    cabin: { type: "string" as const },
    priceTotal: { type: "string" as const },
    bookingUrl: { type: "string" as const },
  },
  required: [
    "from",
    "to",
    "airline",
    "departTime",
    "arriveTime",
    "durationLabel",
    "stops",
    "cabin",
    "priceTotal",
    "bookingUrl",
  ],
};

const HOTEL_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    area: { type: "string" as const },
    stars: { type: "number" as const },
    score: { type: "number" as const, nullable: true },
    reviewCount: { type: "number" as const, nullable: true },
    pricePerNightFrom: { type: "string" as const },
    currency: { type: "string" as const },
    nights: { type: "number" as const },
    badges: { type: "array" as const, items: { type: "string" as const } },
    imageUrl: { type: "string" as const, nullable: true },
    bookingUrl: { type: "string" as const },
    rationale: { type: "string" as const, nullable: true },
  },
  required: [
    "name",
    "area",
    "stars",
    "pricePerNightFrom",
    "currency",
    "nights",
    "badges",
    "bookingUrl",
  ],
};

const EXPERIENCE_SCHEMA = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const },
    description: { type: "string" as const },
    category: { type: "string" as const },
    imageQuery: { type: "string" as const },
  },
  required: ["title", "description", "category", "imageQuery"],
};

const DAY_SCHEMA = {
  type: "object" as const,
  properties: {
    day: { type: "number" as const },
    date: { type: "string" as const },
    title: { type: "string" as const },
    experiences: {
      type: "array" as const,
      items: EXPERIENCE_SCHEMA,
    },
  },
  required: ["day", "date", "title", "experiences"],
};

const TRANSFER_SCHEMA = {
  type: "object" as const,
  properties: {
    from: { type: "string" as const },
    to: { type: "string" as const },
    mode: { type: "string" as const, enum: ["car", "transfer", "flight"] },
    date: { type: "string" as const },
    durationLabel: { type: "string" as const, nullable: true },
    label: { type: "string" as const },
    priceFrom: { type: "string" as const, nullable: true },
  },
  required: ["from", "to", "mode", "date", "label"],
};

const LEG_SCHEMA = {
  type: "object" as const,
  properties: {
    city: { type: "string" as const },
    area: { type: "string" as const, nullable: true },
    startDate: { type: "string" as const },
    endDate: { type: "string" as const },
    description: { type: "string" as const },
    heroImages: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    transferIn: { ...TRANSFER_SCHEMA, nullable: true },
    hotel: HOTEL_SCHEMA,
    days: { type: "array" as const, items: DAY_SCHEMA },
  },
  required: [
    "city",
    "startDate",
    "endDate",
    "description",
    "heroImages",
    "hotel",
    "days",
  ],
};

const RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const },
    destinationName: { type: "string" as const },
    startDate: { type: "string" as const },
    endDate: { type: "string" as const },
    travellers: { type: "string" as const },
    route: { type: "array" as const, items: { type: "string" as const } },
    outboundFlight: FLIGHT_SEGMENT_SCHEMA,
    inboundFlight: FLIGHT_SEGMENT_SCHEMA,
    legs: { type: "array" as const, items: LEG_SCHEMA },
    bookingNote: { type: "string" as const },
  },
  required: [
    "title",
    "destinationName",
    "startDate",
    "endDate",
    "travellers",
    "route",
    "outboundFlight",
    "inboundFlight",
    "legs",
    "bookingNote",
  ],
};

export async function handleGenerate(req: Request): Promise<Response> {
  let body: { messages: Message[]; checklist: Checklist; departureCity?: string };
  try {
    body = (await req.json()) as {
      messages: Message[];
      checklist: Checklist;
      departureCity?: string;
    };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { messages, checklist, departureCity } = body;
  if (!Array.isArray(messages)) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const checklistSummary = Object.entries(checklist)
    .map(([k, v]) => `${k}: ${v.status === "filled" ? v.value : "(open)"}`)
    .join("\n");

  const contextMessage = `Checklist:\n${checklistSummary}${departureCity ? `\nDeparture city (Geolocation): ${departureCity}` : ""}`;

  const secrets = new SecretStore("chatty-edge-trip-planer-secrets");
  const gcpApiKeyEntry = await secrets.get("GCP_API_KEY");
  if (!gcpApiKeyEntry) {
    return new Response(
      JSON.stringify({ error: "API keys not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const ai = new GoogleGenAI({ apiKey: gcpApiKeyEntry.plaintext() });

  const contents = [
    ...messages.map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    })),
    {
      role: "user" as const,
      parts: [{ text: contextMessage }],
    },
  ];

  let result;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.7,
          maxOutputTokens: 65536,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          responseJsonSchema: RESPONSE_SCHEMA,
        },
      });
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!result) {
    return new Response(
      JSON.stringify({ error: "AI request failed", detail: String(lastError) }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const usage = result.usageMetadata;

  if (result.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    return new Response(
      JSON.stringify({
        error:
          "Response was cut off — try a shorter trip duration.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const rawText = result.text;
  if (!rawText) {
    return new Response(
      JSON.stringify({ error: "Empty response from AI" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  let skeleton: TripPlanV2;
  try {
    const tripId = crypto.randomUUID();
    skeleton = JSON.parse(rawText) as TripPlanV2;
    skeleton.tripId = tripId;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON from AI", raw: rawText }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  let enriched: TripPlanV2;
  try {
    enriched = await enrich(skeleton);
  } catch {
    enriched = addStats(skeleton);
  }

  try {
    const store = new KVStore("trip-plans");
    await store.put(`trip_${enriched.tripId}`, JSON.stringify(enriched), { ttl: 7_776_000 });
  } catch (e) {
    console.error("KV Store put failed:", e);
  }

  return new Response(JSON.stringify(enriched), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Token-Input": String(usage?.promptTokenCount ?? 0),
      "X-Token-Output": String(usage?.candidatesTokenCount ?? 0),
      "X-Token-Total": String(usage?.totalTokenCount ?? 0),
    },
  });
}

function addStats(plan: TripPlanV2): TripPlanV2 {
  const totalDays = plan.legs.reduce((s, l) => s + l.days.length, 0);
  const totalExperiences = plan.legs.reduce(
    (s, l) => s + l.days.reduce((s2, d) => s2 + d.experiences.length, 0),
    0,
  );
  const totalTransfers = plan.legs.filter((l) => l.transferIn).length;
  plan.stats = {
    days: totalDays,
    cities: plan.legs.length,
    experiences: totalExperiences,
    hotels: plan.legs.length,
    transfers: totalTransfers + 2,
  };
  if (!plan.heroImage) plan.heroImage = "";
  return plan;
}
