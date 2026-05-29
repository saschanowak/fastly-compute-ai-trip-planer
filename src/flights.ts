/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import { KVStore } from "fastly:kv-store";
import { GoogleGenAI } from "@google/genai";
import type { FlightsRequest, FlightsResponse } from "./types";

const SYSTEM_PROMPT = `You are a flight data generator. Generate realistic fake flight data for the requested routes.
For each flight produce: airline name, IATA from/to codes, departTime (HH:MM), arriveTime (HH:MM),
durationLabel (e.g. "9h 30m"), stops (integer), cabin, priceTotal (e.g. "1234 USD"),
and a bookingUrl using this Skyscanner deep-link pattern:
  https://www.skyscanner.com/flights/{from_iata_lowercase}/{to_iata_lowercase}/{YYMMDD}/?adults={adults}&cabinclass={cabin_lowercase}
where YYMMDD is derived from the date (e.g. 2025-08-15 → 250815).
Reply exclusively with valid JSON following the schema. Do not call any external tools.`;

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
    "from", "to", "airline", "departTime", "arriveTime",
    "durationLabel", "stops", "cabin", "priceTotal", "bookingUrl",
  ],
};

const RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    outboundFlight: FLIGHT_SEGMENT_SCHEMA,
    inboundFlight: FLIGHT_SEGMENT_SCHEMA,
  },
  required: ["outboundFlight", "inboundFlight"],
};

export async function handleFlights(req: Request, tripId: string): Promise<Response> {
  let body: FlightsRequest;
  try {
    body = (await req.json()) as FlightsRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    departureCity,
    firstLegCity,
    lastLegCity,
    startDate,
    endDate,
    travellers,
    cabinPreference,
  } = body;

  if (!departureCity || !firstLegCity || !lastLegCity || !startDate || !endDate || !travellers) {
    return new Response(
      JSON.stringify({ error: "departureCity, firstLegCity, lastLegCity, startDate, endDate, travellers are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const sanitize = (s: string, max = 100) => String(s).slice(0, max).replace(/[\n\r]/g, " ");
  const safeFrom = sanitize(departureCity);
  const safeFirstLeg = sanitize(firstLegCity);
  const safeLastLeg = sanitize(lastLegCity);
  const safeStart = sanitize(startDate, 10);
  const safeEnd = sanitize(endDate, 10);
  const safeTravellers = sanitize(travellers, 80);
  const safeCabin = sanitize(cabinPreference || "Economy", 40);

  const cacheKey = `flight_${tripId}`;
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
    console.error("flights: KV get failed:", e);
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

  const userMessage = `Generate fake flight data for:
Travellers: ${safeTravellers}
Preferred cabin: ${safeCabin}

Outbound: ${safeFrom} → ${safeFirstLeg} on ${safeStart}
Inbound: ${safeLastLeg} → ${safeFrom} on ${safeEnd}`;

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
    console.error("flights: Gemini request failed:", lastError);
    return new Response(
      JSON.stringify({ error: "Flight search failed. Please try again." }),
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

  let parsed: FlightsResponse;
  try {
    parsed = JSON.parse(rawText) as FlightsResponse;
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON from AI" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const store = new KVStore("trip-plans");
    await store.put(cacheKey, JSON.stringify(parsed), { ttl: 7_776_000 });
  } catch (e) {
    console.error("flights: KV put failed:", e);
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
