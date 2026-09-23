"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Home } from "lucide-react";
import type { EmailIntent } from "@/lib/auth/types";
import AuthShell from "./AuthShell";
import FarmStep from "./FarmStep";
import MethodStep from "./MethodStep";
import RoleStep from "./RoleStep";
import SuccessStep from "./SuccessStep";
import WilayaStep from "./WilayaStep";
import { useAuthFlow } from "./useAuthFlow";
import { EASE_OUT, GPU } from "./ui";

/**
 * The whole multi-step authentication workflow:
 *   1. method + credentials (Google / phone OTP / e-mail)
 *   2. role (farmer · agronomist · investor)
 *   3. wilaya (seeds weather + crops)
 *   4. farm (preferred crop + land size — optional, skippable)
 *   → success → /dashboard
 *
 * Rendered by /auth, /login and /register with a different initial tab; the
 * three routes share one state machine, one copy table and one gateway.
 */
export default function AuthFlow({ initialMode = "signin" }: { initialMode?: EmailIntent }) {
  const flow = useAuthFlow({ initialMode });
  const stepKey = flow.step;
  const allDone = stepKey === "done";

  return (
    <AuthShell
      t={flow.t}
      lang={flow.lang}
      onLangChange={flow.setLang}
      navHref="/"
      navLabel={flow.t.header.navHome}
      navIcon={<Home size={15} strokeWidth={2.6} aria-hidden />}
      plan={flow.plan}
      current={allDone ? flow.plan[flow.plan.length - 1] : stepKey}
      allDone={allDone}
      onStepSelect={(step) => {
        // Backwards only: the ladder re-opens decisions, it never skips ahead.
        if (flow.plan.indexOf(step) <= flow.plan.indexOf(flow.step)) flow.goToStep(step);
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={stepKey}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.26, ease: EASE_OUT }}
          className={GPU}
        >
          {stepKey === "method" && <MethodStep flow={flow} />}
          {stepKey === "role" && <RoleStep flow={flow} />}
          {stepKey === "location" && <WilayaStep flow={flow} />}
          {stepKey === "farm" && <FarmStep flow={flow} />}
          {stepKey === "done" && <SuccessStep flow={flow} />}
        </motion.div>
      </AnimatePresence>
    </AuthShell>
  );
}
