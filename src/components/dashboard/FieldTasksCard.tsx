"use client";

import { ClipboardList } from "lucide-react";
import { useMemo, useState } from "react";
import { computeIrrigation, weatherFor } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { CROPS, type CropKey, type Lang } from "@/lib/wilayas";
import { fmt } from "./WeatherCard";
import { Card, Chip, Progress } from "./parts";

interface Task {
  id: string;
  title: string;
  detail: string;
}

/** Daily checklist derived from the same numbers the other cards show. */
export default function FieldTasksCard({
  t,
  lang,
  wilayaCode,
  crop,
  areaHa = 2,
}: {
  t: DashboardCopy;
  lang: Lang;
  wilayaCode: string;
  crop: CropKey;
  areaHa?: number;
}) {
  const weather = weatherFor(wilayaCode);
  const irrigation = computeIrrigation({
    wilayaCode,
    crop,
    areaHa,
    soil: weather.wilaya.soil,
    system: "drip",
  });

  const tasks = useMemo<Task[]>(
    () => [
      {
        id: "irrigation",
        title: t.tasks.irrigation,
        detail: t.tasks.irrigationDetail.replace("{value}", fmt(irrigation.dailyM3, 1)),
      },
      {
        id: "wind",
        title: t.tasks.wind,
        detail: t.tasks.windDetail.replace("{value}", fmt(weather.windKph)),
      },
      {
        id: "heat",
        title: t.tasks.heat,
        detail: t.tasks.heatDetail.replace("{value}", fmt(weather.tempC)),
      },
      {
        id: "scan",
        title: t.tasks.scan,
        detail: t.tasks.scanDetail,
      },
    ],
    [irrigation.dailyM3, t.tasks, weather.tempC, weather.windKph],
  );

  const [done, setDone] = useState<Record<string, boolean>>({});
  const doneCount = Object.values(done).filter(Boolean).length;
  const remaining = tasks.length - doneCount;

  return (
    <Card
      title={t.tasks.title}
      subtitle={`${t.tasks.subtitle} · ${CROPS[crop][lang]}`}
      icon={<ClipboardList size={18} strokeWidth={2.4} aria-hidden />}
      aside={
        <Chip tone={remaining === 0 ? "emerald" : "amber"}>
          {remaining === 0 ? t.tasks.done : t.tasks.remaining.replace("{n}", String(remaining))}
        </Chip>
      }
    >
      <Progress value={(doneCount / tasks.length) * 100} />

      <ul className="mt-3.5 flex flex-col gap-2">
        {tasks.map((task) => {
          const checked = Boolean(done[task.id]);
          return (
            <li key={task.id}>
              <label
                className={`flex min-h-[3.25rem] cursor-pointer items-start gap-3 rounded-[1rem] px-3 py-2.5 ring-1 transition-colors ${
                  checked
                    ? "bg-emerald-50 ring-emerald-200"
                    : "bg-[#f6faf7] ring-[rgba(6,78,59,0.07)] hover:ring-emerald-200"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setDone((prev) => ({ ...prev, [task.id]: e.target.checked }))}
                  className="mt-[3px] h-5 w-5 shrink-0 accent-emerald-600"
                />
                <span className="min-w-0">
                  <span
                    className={`block text-[13.5px] font-black ${
                      checked ? "text-emerald-700/70 line-through" : "text-emerald-950"
                    }`}
                  >
                    {task.title}
                  </span>
                  <span className="mt-1 block text-[11.5px] font-semibold leading-[1.7] text-emerald-900/65">
                    {task.detail}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
