import type { Metadata } from "next";
import "./exploration.css";
import ExplorationLab from "@/components/exploration/ExplorationLab";

export const metadata: Metadata = {
  title: "Exploration Lab · Smart Crop AI",
  description: "Three visual directions for the Smart Crop AI experience.",
};

export default function ExplorationLabPage() {
  return <ExplorationLab />;
}
