/// <reference types="@fastly/js-compute" />
import { CacheOverride } from "fastly:cache-override";
import type { TripPlanV2, Weather, WeatherIcon } from "./types";

const WEATHER_CACHE_TTL = 6 * 3600; // 6 hours
const IMAGE_CACHE_TTL = 30 * 86400; // 30 days

// ---------- Open-Meteo: geocode city → lat/lng ----------

interface GeoResult {
  latitude: number;
  longitude: number;
}

async function geocodeCity(city: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`;
  try {
    const resp = await fetch(url, {
      backend: "open_meteo_geocoding",
      cacheOverride: new CacheOverride("override", { ttl: IMAGE_CACHE_TTL }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      results?: { latitude: number; longitude: number }[];
    };
    if (!data.results?.length) return null;
    return {
      latitude: data.results[0].latitude,
      longitude: data.results[0].longitude,
    };
  } catch {
    return null;
  }
}

// ---------- Wikimedia Commons: image by search query ----------

export async function fetchWikimediaImage(query: string, width = 400): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "1",
    prop: "imageinfo",
    iiprop: "url",
    iiurlwidth: String(width),
    format: "json",
  });
  try {
    const resp = await fetch(
      `https://commons.wikimedia.org/w/api.php?${params}`,
      {
        backend: "wikimedia",
        headers: {
          "User-Agent": "FastlyChattyEdgeAi/1.0 (https://github.com/saschanowak/fastly-compute-ai-trip-planer; ai-based-trip-planner)",
        },
        cacheOverride: new CacheOverride("override", { ttl: IMAGE_CACHE_TTL }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const pages = data?.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0] as any;
    const info = page?.imageinfo?.[0];
    return info?.thumburl ?? info?.url ?? null;
  } catch (error) {
    return null;
  }
}

// ---------- Open-Meteo: weather per day ----------

const WMO_TO_ICON: Record<number, WeatherIcon> = {
  0: "sun",
  1: "sun",
  2: "cloud",
  3: "cloud",
  45: "cloud",
  48: "cloud",
  51: "rain",
  53: "rain",
  55: "rain",
  56: "rain",
  57: "rain",
  61: "rain",
  63: "rain",
  65: "rain",
  66: "rain",
  67: "rain",
  71: "cloud",
  73: "cloud",
  75: "cloud",
  77: "cloud",
  80: "rain",
  81: "rain",
  82: "storm",
  85: "cloud",
  86: "cloud",
  95: "storm",
  96: "storm",
  99: "storm",
};

async function fetchWeatherForDays(
  lat: number,
  lng: number,
  dates: string[],
): Promise<Map<string, Weather>> {
  const result = new Map<string, Weather>();
  if (!dates.length) return result;

  const sorted = [...dates].sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];

  const now = new Date();
  const start = new Date(startDate);
  const diffDays = (start.getTime() - now.getTime()) / 86400000;

  let source: "forecast" | "climate" = "forecast";
  let apiUrl: string;

  if (diffDays <= 16) {
    apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,weather_code&start_date=${startDate}&end_date=${endDate}&timezone=auto`;
  } else {
    source = "climate";
    const startMonth = parseInt(startDate.slice(5, 7), 10);
    const endMonth = parseInt(endDate.slice(5, 7), 10);
    const monthDay = startDate.slice(5);
    const endMonthDay = endDate.slice(5);
    apiUrl = `https://climate-api.open-meteo.com/v1/climate?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max_mean,weather_code_mode&start_date=1991-${monthDay}&end_date=2020-${endMonthDay}&models=EC_Earth3P_HR`;
  }

  try {
    const resp = await fetch(apiUrl, {
      backend: "open_meteo_api",
      cacheOverride: new CacheOverride("override", { ttl: WEATHER_CACHE_TTL }),
    });
    if (!resp.ok) return result;
    const data = (await resp.json()) as {
      daily?: {
        time?: string[];
        temperature_2m_max?: number[];
        temperature_2m_max_mean?: number[];
        weather_code?: number[];
        weather_code_mode?: number[];
      };
    };
    const daily = data.daily;
    if (!daily?.time) return result;

    const temps = daily.temperature_2m_max ?? daily.temperature_2m_max_mean ?? [];
    const codes = daily.weather_code ?? daily.weather_code_mode ?? [];

    for (let i = 0; i < daily.time.length; i++) {
      const dateStr = daily.time[i];
      if (dates.includes(dateStr)) {
        result.set(dateStr, {
          tempC: Math.round(temps[i] ?? 0),
          icon: WMO_TO_ICON[codes[i] ?? 0] ?? "cloud",
          source,
        });
      }
    }
  } catch {
    // graceful degradation
  }

  return result;
}

// ---------- Main enrichment orchestrator ----------

export async function enrich(skeleton: TripPlanV2): Promise<TripPlanV2> {
  const tasks: Promise<void>[] = [];

  // Hero image for the overall destination
  tasks.push(
    fetchWikimediaImage(skeleton.destinationName).then((url) => {
      if (url) skeleton.heroImage = url;
    }),
  );

  // Per-leg: weather + city gallery images + hotel image + experience images
  for (const leg of skeleton.legs) {
    tasks.push(
      (async () => {
        const [geo, img0, img1, hotelImg] = await Promise.all([
          geocodeCity(leg.city),
          fetchWikimediaImage(leg.city, 400),
          fetchWikimediaImage(`${leg.city} landmark`, 400),
          fetchWikimediaImage(leg.hotel.name, 300),
        ]);

        if (img0) leg.heroImages[0] = img0;
        if (img1) leg.heroImages[1] = img1;
        if (hotelImg) leg.hotel.imageUrl = hotelImg;

        if (geo) {
          const dates = leg.days.map((d) => d.date);
          const weatherMap = await fetchWeatherForDays(
            geo.latitude,
            geo.longitude,
            dates,
          );
          for (const day of leg.days) {
            const w = weatherMap.get(day.date);
            if (w) day.weather = w;
          }
        }

        // Experience images — concurrent within the leg
        const expTasks: Promise<void>[] = [];
        for (const day of leg.days) {
          for (const exp of day.experiences) {
            if (exp.imageQuery) {
              expTasks.push(
                fetchWikimediaImage(exp.imageQuery, 200).then((url) => {
                  if (url) exp.imageUrl = url;
                }),
              );
            }
          }
        }
        await Promise.all(expTasks);
      })(),
    );
  }

  await Promise.all(tasks);

  // Compute stats
  const totalDays = skeleton.legs.reduce((s, l) => s + l.days.length, 0);
  const totalExperiences = skeleton.legs.reduce(
    (s, l) => s + l.days.reduce((s2, d) => s2 + d.experiences.length, 0),
    0,
  );
  const totalTransfers = skeleton.legs.filter((l) => l.transferIn).length;

  skeleton.stats = {
    days: totalDays,
    cities: skeleton.legs.length,
    experiences: totalExperiences,
    hotels: skeleton.legs.length,
    transfers: totalTransfers + 2, // +2 for outbound/inbound flights
  };

  if (!skeleton.heroImage) skeleton.heroImage = "";

  return skeleton;
}
