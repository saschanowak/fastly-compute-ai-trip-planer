/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import { KVStore } from "fastly:kv-store";
import { GoogleGenAI } from "@google/genai";
import type { HotelRequest, HotelResponse } from "./types";
import { fetchWikimediaImage } from "./enrich";

const SYSTEM_PROMPT = `You are a hotel data generator. Generate realistic fake hotel data based on your knowledge of real hotels in the requested city.
Use real hotel names that exist in the city, realistic prices, and appropriate star ratings for the traveller style.
For each hotel produce: name, area (neighbourhood), stars, score (1-10), reviewCount, pricePerNightFrom (number as string, e.g. "189"),
"EUR" as currency, nights, 2-3 relevant badges, a one-sentence rationale explaining why it fits the traveller style,
and a bookingUrl using this Trivago deep-link pattern: https://www.trivago.com/en-US/srl/hotels-{city_slug}?search={hotel_name_url_encoded};dr-{date_range}
where city_slug is the city name lowercased with spaces replaced by hyphens (e.g. "new-york"),
hotel_name_url_encoded is the hotel name URL-encoded (e.g. "Four%20Seasons") and
date_range is the safeStart and safeEnd date in the format yyyymmdd-yyyymmdd (e.g. "20261216-20261231").
Reply exclusively with valid JSON following the schema. Do not call any external tools.`;

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
    "imageUrl",
    "bookingUrl",
    "rationale",
  ],
};

const RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    legIndex: { type: "number" as const },
    hotel: HOTEL_SCHEMA,
  },
  required: ["legIndex", "hotel"],
};

export async function handleHotel(req: Request, tripId: string): Promise<Response> {
  let body: HotelRequest;
  try {
    body = (await req.json()) as HotelRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { legIndex, city, area, startDate, endDate, nights, style, travellers } = body;
  if (!Number.isInteger(legIndex) || legIndex < 0 || !city) {
    return new Response(JSON.stringify({ error: "legIndex must be a non-negative integer and city must be non-empty" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sanitize = (s: unknown, max = 100) => String(s ?? "").slice(0, max).replace(/[\n\r]/g, " ");
  const safeCity = sanitize(city);
  const safeArea = area ? ` (${sanitize(area)})` : "";
  const safeStart = sanitize(startDate, 10);
  const safeEnd = sanitize(endDate, 10);
  const safeStyle = sanitize(style, 500);
  const safeTravellers = sanitize(travellers, 80);

  const cacheKey = `hotel_${tripId}_${legIndex}`;
  try {
    const store = new KVStore("trip-plans");
    const entry = await store.get(cacheKey);
    const cached = (await entry?.text()) ?? null;
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      });
    }
  } catch (e) {
    console.error("hotel: KV get failed:", e);
  }

  const secrets = new SecretStore("chatty-edge-trip-planer-secrets");
  const gcpApiKeyEntry = await secrets.get("GCP_API_KEY");
  if (!gcpApiKeyEntry) {
    return new Response(
      JSON.stringify({ error: "API keys not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const ai = new GoogleGenAI({ apiKey: gcpApiKeyEntry.plaintext() });

  const userMessage = `Find a hotel for the following trip leg:
Travellers: ${safeTravellers}
Style / Interests: ${safeStyle}
City: ${safeCity}
Area: ${safeArea}
Start: ${safeStart}
End: ${safeEnd}
Nights: ${Number(nights)}
LegIndex: ${Number(legIndex)}
`;

  let result;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: [{ role: "user" as const, parts: [{ text: userMessage }] }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.7,
          maxOutputTokens: 1024,
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

  const usage = result?.usageMetadata;

  if (!result) {
    console.error("hotel: Gemini request failed:", lastError);
    return new Response(
      JSON.stringify({ legIndex, hotel: null, error: "Hotel search failed. Please try again." }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const rawText = result.text;
  if (!rawText) {
    return new Response(
      JSON.stringify({ legIndex, hotel: null, error: "Empty response from AI" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  let parsed: HotelResponse;
  try {
    parsed = JSON.parse(rawText) as HotelResponse;
  } catch {
    return new Response(
      JSON.stringify({ legIndex, hotel: null, error: "Invalid JSON from AI" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  if (parsed.hotel) {
    const img = await fetchWikimediaImage(parsed.hotel.name, 300);
    if (img) parsed.hotel.imageUrl = img;
  }

  try {
    const store = new KVStore("trip-plans");
    await store.put(cacheKey, JSON.stringify(parsed), { ttl: 7_776_000 });
  } catch (e) {
    console.error("hotel: KV put failed:", e);
  }

  return new Response(JSON.stringify(parsed), {
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
