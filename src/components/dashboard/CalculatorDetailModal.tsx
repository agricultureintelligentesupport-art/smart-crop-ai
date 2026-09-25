"use client";

import Sheet from "@/components/app/Sheet";
import type { WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { Lang } from "@/lib/wilayas";
import IrrigationCard, { type ParcelInput } from "./IrrigationCard";

/**
 * Calculator sheet — opened by the "حاسبة السقي" quick-access widget.
 *
 * A thin, modular wrapper: the shared `Sheet` owns the modal contract (drag-to-
 * dismiss handle, ✕, Escape, focus trap, spring slide-up) and `IrrigationCard`
 * renders the complete calculator — crop select, area slider + steppers, soil
 * select, system toggle and the four resulting volumes.
 *
 * The parcel inputs are owned by `DashboardView`, so an edit here updates the
 * widget and the hero decision card in the same render, with no extra wiring.
 */
export default function CalculatorDetailModal({
  open,
  onClose,
  t,
  lang,
  wilayaCode,
  parcel,
  onParcelChange,
  areaHa,
  onAreaChange,
  weather,
}: {
  open: boolean;
  onClose: () => void;
  t: DashboardCopy;
  lang: Lang;
  wilayaCode: string;
  /** Crop + soil + system, owned by the dashboard (shared with the hero card). */
  parcel: ParcelInput;
  onParcelChange: (patch: Partial<ParcelInput>) => void;
  areaHa: number;
  onAreaChange: (area: number) => void;
  /** The dashboard's live/reference snapshot (feeds ET₀ exactly as before). */
  weather: WeatherSnapshot;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="tall"
      lang={lang}
      title={t.irrigation.title}
      subtitle={t.irrigation.subtitle}
    >
      <IrrigationCard
        t={t}
        lang={lang}
        wilayaCode={wilayaCode}
        parcel={parcel}
        onParcelChange={onParcelChange}
        areaHa={areaHa}
        onAreaChange={onAreaChange}
        weather={weather}
      />
    </Sheet>
  );
}
