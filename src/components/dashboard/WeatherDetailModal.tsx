"use client";

import Sheet from "@/components/app/Sheet";
import type { WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { WeatherSource } from "@/lib/weather/useLiveWeather";
import { getWilaya, type Lang } from "@/lib/wilayas";
import WeatherCard from "./WeatherCard";

/**
 * Weather details sheet — opened by the "الطقس والتوقعات" quick-access widget.
 *
 * A thin, modular wrapper: the shared `Sheet` owns the modal contract (drag-to-
 * dismiss handle, ✕, Escape, focus trap, spring slide-up) and `WeatherCard`
 * renders the complete view — the same hourly strip, 7-day forecast, metrics
 * and source note the dashboard used to show inline. No calculation lives here.
 */
export default function WeatherDetailModal({
  open,
  onClose,
  t,
  lang,
  wilayaCode,
  weather,
  source,
  fetchedAt,
}: {
  open: boolean;
  onClose: () => void;
  t: DashboardCopy;
  lang: Lang;
  /** Wilaya whose name the sheet subtitle prints. */
  wilayaCode: string;
  /** The same live/reference snapshot the widget and the hero card read. */
  weather: WeatherSnapshot;
  /** Where `weather`'s numbers come from (drives the source note). */
  source: WeatherSource;
  /** Epoch ms of the successful live fetch (null in reference mode). */
  fetchedAt: number | null;
}) {
  const wilaya = getWilaya(wilayaCode);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="tall"
      lang={lang}
      title={t.weather.title}
      subtitle={t.weather.subtitle.replace("{wilaya}", lang === "ar" ? wilaya.nameAr : wilaya.nameFr)}
    >
      <WeatherCard t={t} lang={lang} weather={weather} source={source} fetchedAt={fetchedAt} />
    </Sheet>
  );
}
