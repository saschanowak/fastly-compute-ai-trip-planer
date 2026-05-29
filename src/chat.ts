/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import { GoogleGenAI } from "@google/genai";
import type { Message } from "./types";

const BASE_SYSTEM_PROMPT = `You are an enthusiastic AI travel planner. You speak English, casually and with personality (a fitting emoji now and then, but sparingly).

Goal of this phase: collect five key data points in natural conversation — always only one or two at a time, never ask for everything at once.

Checklist (exactly these five fields):
1. destination   – Travel destination (or "Surprise me")
2. departureFrom – Departure city (pre-filled below; just confirm it)
3. travellers    – Travellers (solo / couple / family incl. children's ages)
4. when          – Travel period or duration (exact dates needed later for hotel)
5. interests     – Style + budget + interests, summarised (e.g. "Luxury, Golf, Beach Club")

Behaviour:
- Always reply in English.
- Only mark a field as "filled" when the information is clearly present.
  "departureFrom" counts as filled once the pre-filled city is confirmed or another is named.
- You do NOT have to wait for all five fields. If the user wants to generate earlier,
  missing fields will be filled with reasonable assumptions later.
- Always ask for only 1–2 missing fields per message.
- Be enthusiastic but not over the top.
- Set "autostart" to true ONLY when the user explicitly asks to generate/start the trip
  (e.g. "let's go", "start planning", "generate my trip", "I'm ready").
  Otherwise always set autostart to false.

Response format (always valid JSON, nothing outside it):
{
  "reply": "<your message in English>",
  "checklist": {
    "destination":   { "status": "filled"|"pending", "value": <string|null> },
    "departureFrom": { "status": "filled"|"pending", "value": <string|null> },
    "travellers":    { "status": "filled"|"pending", "value": <string|null> },
    "when":          { "status": "filled"|"pending", "value": <string|null> },
    "interests":     { "status": "filled"|"pending", "value": <string|null> }
  },
  "autostart": false
}`;

const CHECKLIST_SLOT_SCHEMA = {
  type: "object" as const,
  properties: {
    status: { type: "string" as const, enum: ["filled", "pending"] },
    value: { type: "string" as const, nullable: true },
  },
  required: ["status", "value"],
};

const RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    reply: {
      type: "string" as const,
      description: "Conversational message in English.",
    },
    checklist: {
      type: "object" as const,
      properties: {
        destination: CHECKLIST_SLOT_SCHEMA,
        departureFrom: CHECKLIST_SLOT_SCHEMA,
        travellers: CHECKLIST_SLOT_SCHEMA,
        when: CHECKLIST_SLOT_SCHEMA,
        interests: CHECKLIST_SLOT_SCHEMA,
      },
      required: ["destination", "departureFrom", "travellers", "when", "interests"],
    },
    autostart: {
      type: "boolean" as const,
      description: "True only when the user explicitly asks to generate or start the trip.",
    },
  },
  required: ["reply", "checklist", "autostart"],
};

export async function handleChat(req: Request): Promise<Response> {
  let body: { messages: Message[]; departureCity?: string };
  try {
    body = (await req.json()) as { messages: Message[]; departureCity?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { messages, departureCity } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const departureLine = departureCity
    ? `\n\nPre-filled departure city: ${departureCity}`
    : "";
  const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + departureLine;

  const secrets = new SecretStore("chatty-edge-trip-planer-secrets");
  const gcpApiKeyEntry = await secrets.get("GCP_API_KEY");
  if (!gcpApiKeyEntry) {
    return new Response(
      JSON.stringify({ error: "API keys not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const ai = new GoogleGenAI({ apiKey: gcpApiKeyEntry.plaintext() });

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));

  let result;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
    result = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.7,
        maxOutputTokens: 4096,
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

  return new Response(
    result.text ??
      '{"reply":"Sorry, something went wrong. Please try again.","checklist":{"destination":{"status":"pending","value":null},"departureFrom":{"status":"pending","value":null},"travellers":{"status":"pending","value":null},"when":{"status":"pending","value":null},"interests":{"status":"pending","value":null}}}',
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Token-Input": String(usage?.promptTokenCount ?? 0),
        "X-Token-Output": String(usage?.candidatesTokenCount ?? 0),
        "X-Token-Total": String(usage?.totalTokenCount ?? 0),
      },
    },
  );
}
