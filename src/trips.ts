/// <reference types="@fastly/js-compute" />
import { KVStore } from "fastly:kv-store";

export async function handleGetTrip(tripId: string): Promise<Response> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      tripId,
    )
  ) {
    return new Response(JSON.stringify({ error: "Invalid trip ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let text: string | null = null;
  try {
    const store = new KVStore("trip-plans");
    const entry = await store.get(`trip_${tripId}`);
    text = (await entry?.text()) ?? null;
  } catch (e) {
    console.error("KV Store get failed:", e);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve trip" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (text === null) {
    return new Response(JSON.stringify({ error: "Trip not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
