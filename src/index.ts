/// <reference types="@fastly/js-compute" />
import { env } from "fastly:env";
import { allowDynamicBackends, includeBytes } from "fastly:experimental";
import { setDefaultDynamicBackendConfig } from "fastly:backend";
import { getGeolocationForIpAddress } from "fastly:geolocation";
import { handleChat } from "./chat";
import { handleGenerate } from "./generate";
import { handleHotel } from "./hotel";
import { handleFlights } from "./flights";
import { handleGetTrip } from "./trips";

allowDynamicBackends(true);
setDefaultDynamicBackendConfig({
  connectTimeout: 5_000,
  firstByteTimeout: 120_000,
  betweenBytesTimeout: 30_000,
  useSSL: true,
});

const chatUI = includeBytes("./src/ui.html");
const ALT_SVC = 'h3=":443";ma=86400,h3-29=":443";ma=86400,h3-27=":443";ma=86400';

addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));

async function handleRequest(event: FetchEvent): Promise<Response> {
  const response = await routeRequest(event);
  response.headers.set("Alt-Svc", ALT_SVC);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function routeRequest(event: FetchEvent): Promise<Response> {
  console.log("FASTLY_SERVICE_VERSION:", env("FASTLY_SERVICE_VERSION") || "local");

  const req = event.request;
  const url = new URL(req.url);

  if (url.pathname === "/api/geo") {
    if (!["GET", "HEAD"].includes(req.method)) {
      return new Response("Method not allowed", { status: 405 });
    }
    const fallbackLocation = {
      city: "Frankfurt",
      country_name: "Germany",
      country_code: "DE",
      is_fallback: true,
    };
    const { address } = event.client;
    if (address === "127.0.0.1") {
      return new Response(JSON.stringify(fallbackLocation), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
    const geo = getGeolocationForIpAddress(event.client.address);
    const payload = geo?.city
      ? {
          city: geo.city,
          country_name: geo.country_name,
          country_code: geo.country_code,
          is_fallback: false,
        }
      : fallbackLocation;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    return handleChat(req);
  }

  if (url.pathname === "/api/generate") {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    return handleGenerate(req);
  }

  const hotelMatch = url.pathname.match(/^\/api\/hotel\/([^/]+)$/);
  if (hotelMatch) {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    return handleHotel(req, hotelMatch[1]);
  }


  const flightsMatch = url.pathname.match(/^\/api\/flights\/([^/]+)$/);
  if (flightsMatch) {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    return handleFlights(req, flightsMatch[1]);
  }

  const tripsMatch = url.pathname.match(/^\/api\/trips\/([^/]+)$/);
  if (tripsMatch) {
    if (req.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    return handleGetTrip(tripsMatch[1]);
  }

  if (url.pathname === "/" || url.pathname.startsWith("/trip/")) {
    if (!["GET", "HEAD"].includes(req.method)) {
      return new Response("Method not allowed", { status: 405 });
    }
    return new Response(chatUI, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8"
      },
    });
  }

  return new Response("Not found", { status: 404 });
}
