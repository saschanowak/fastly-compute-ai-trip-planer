export interface Message {
  role: "user" | "assistant";
  content: string;
}

// ---------- Phase A ----------
export type SlotStatus = "filled" | "pending";
export interface ChecklistSlot {
  status: SlotStatus;
  value: string | null;
}
export interface Checklist {
  destination: ChecklistSlot;
  departureFrom: ChecklistSlot;
  travellers: ChecklistSlot;
  when: ChecklistSlot;
  interests: ChecklistSlot;
}
export interface ChatTurn {
  reply: string;
  checklist: Checklist;
  autostart?: boolean;
}

// ---------- Phase B/C ----------
export type WeatherIcon = "sun" | "cloud" | "rain" | "storm";
export interface Weather {
  tempC: number;
  icon: WeatherIcon;
  source: "forecast" | "climate";
}

export interface Experience {
  title: string;
  description: string;
  category: string;
  imageQuery: string;
  imageUrl?: string;
  rating?: number;
}

export interface Day {
  day: number;
  date: string;
  title: string;
  weather?: Weather;
  experiences: Experience[];
}

export interface Transfer {
  from: string;
  to: string;
  mode: "car" | "transfer" | "flight";
  date: string;
  durationLabel?: string;
  label: string;
  priceFrom?: string;
}

export interface HotelCard {
  name: string;
  area: string;
  stars: number;
  score?: number;
  reviewCount?: number;
  pricePerNightFrom: string;
  currency: string;
  nights: number;
  badges: string[];
  imageUrl?: string;
  bookingUrl: string;
  rationale?: string;
}

export interface FlightSegment {
  from: string;
  to: string;
  airline: string;
  airlineLogoUrl?: string;
  departTime: string;
  arriveTime: string;
  durationLabel: string;
  stops: number;
  cabin: string;
  priceTotal: string;
  bookingUrl: string;
}

export interface Leg {
  city: string;
  area?: string;
  startDate: string;
  endDate: string;
  description: string;
  heroImages: string[];
  transferIn?: Transfer;
  hotel: HotelCard;
  days: Day[];
}

export interface TripStats {
  days: number;
  cities: number;
  experiences: number;
  hotels: number;
  transfers: number;
}

export interface TripPlanV2 {
  tripId: string;
  title: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  travellers: string;
  stats: TripStats;
  heroImage: string;
  route: string[];
  outboundFlight: FlightSegment;
  inboundFlight: FlightSegment;
  legs: Leg[];
  bookingNote: string;
}

// ---------- Hotel / flight enrichment endpoints ----------
export interface HotelRequest {
  legIndex: number;
  city: string;
  area?: string | null;
  startDate: string;
  endDate: string;
  nights: number;
  style: string;
  travellers: string;
}

export interface HotelResponse {
  legIndex: number;
  hotel: HotelCard | null;
  error?: string;
}

export interface FlightsRequest {
  departureCity: string;
  firstLegCity: string;
  lastLegCity: string;
  startDate: string;
  endDate: string;
  travellers: string;
  cabinPreference?: string;
}

export interface FlightsResponse {
  outboundFlight: FlightSegment | null;
  inboundFlight: FlightSegment | null;
}
