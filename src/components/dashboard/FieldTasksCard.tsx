"use client";

import { motion } from "framer-motion";
import { Check, ClipboardList } from "lucide-react";
import { useMemo, useState } from "react";
import { SPRING } from "@/components/auth/ui";
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

/**
 * Daily checklist derived from the same numbers the other cards show.
 * `limit` caps how many tasks are rendered (the bento home shows the top 3);
 * completion state and progress logic stay fully functional.
 */
export default function FieldTasksCard({
  t,
  lang,
  wilayaCode,
  crop,
  areaHa = 2,
  limit,
}: {
  t: DashboardCopy;
  lang: Lang;
  wilayaCode: string;
  crop: CropKey;
  areaHa?: number;
  limit?: number;
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
  const visibleTasks = limit ? tasks.slice(0, limit) : tasks;
  const doneCount = visibleTasks.filter((task) => Boolean(done[task.id])).length;
  const remaining = visibleTasks.length - doneCount;

  return (
    <Card
      title={t.tasks.title}
      subtitle={`${t.tasks.subtitle} · ${CROPS[crop][lang]}`}
      icon={<ClipboardList size={17} strokeWidth={2.4} aria-hidden />}
      aside={
        <Chip tone={remaining === 0 ? "emerald" : "amber"}>
          {remaining === 0 ? t.tasks.done : t.tasks.remaining.replace("{n}", String(remaining))}
        </Chip>
      }
    >
      <Progress value={(doneCount / visibleTasks.length) * 100} />

      <ul className="mt-3 flex flex-col gap-2">
        {visibleTasks.map((task) => {
          const checked = Boolean(done[task.id]);
          return (
            <li key={task.id}>
              <label
                className={`relative flex cursor-pointer items-start gap-2.5 rounded-2xl px-2.5 py-2.5 ring-1 transition-all duration-200 active:scale-[0.99] ${
                  checked
                    ? "bg-emerald-50/90 ring-emerald-200"
                    : "bg-white/75 ring-[#E2F1E8] hover:ring-emerald-200"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setDone((prev) => ({ ...prev, [task.id]: e.target.checked }))}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={`mt-[1px] grid h-6 w-6 shrink-0 place-items-center rounded-xl border-2 transition-colors duration-200 peer-focus-visible:ring-4 peer-focus-visible:ring-emerald-400/45 ${
                    checked ? "border-emerald-500 bg-emerald-500" : "border-emerald-300/70 bg-white"
                  }`}
                >
                  <motion.span
                    initial={false}
                    animate={{ scale: checked ? 1 : 0.4, opacity: checked ? 1 : 0 }}
                    transition={SPRING}
                  >
                    <Check size={14} strokeWidth={3.6} className="text-white" />
                  </motion.span>
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[12.5px] font-black transition-colors duration-200 ${
                      checked ? "text-emerald-700/70 line-through" : "text-emerald-950"
                    }`}
                  >
                    {task.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] font-semibold leading-5 text-emerald-900/70">
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
