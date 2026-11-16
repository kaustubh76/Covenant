"use client";

import { animate, motion, useInView, useReducedMotion } from "framer-motion";
import { type ReactNode, useEffect, useRef, useState } from "react";

export const Container = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={`mx-auto max-w-[1320px] px-4 md:px-8 ${className ?? ""}`}>{children}</div>
);

/** Fade and rise into place the first time the element scrolls into view. */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-12% 0px" }}
      transition={{ duration: 0.7, delay, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Counts from `from` to `to` once visible. */
export function CountUp({ to, from = 0, dp = 0, prefix = "", suffix = "" }: { to: number; from?: number; dp?: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true, margin: "-10% 0px" });
  const reduce = useReducedMotion();
  // Start from `from` on the server and in the browser alike; the motion setting only decides what happens next.
  const [v, setV] = useState(from);
  useEffect(() => {
    if (!seen) return;
    if (reduce) {
      setV(to);
      return;
    }
    const c = animate(from, to, { duration: 1.4, ease: [0.2, 0.7, 0.2, 1], onUpdate: setV });
    return () => c.stop();
  }, [seen, reduce, from, to]);
  return (
    <span ref={ref}>
      {prefix}
      {v.toFixed(dp)}
      {suffix}
    </span>
  );
}

export function SectionHead({ eyebrow, title, lead, center }: { eyebrow: string; title: ReactNode; lead?: ReactNode; center?: boolean }) {
  return (
    <Reveal className={center ? "mx-auto max-w-3xl text-center" : "max-w-3xl"}>
      <div className="eyebrow">{eyebrow}</div>
      <h2 className="display mt-3 text-[38px] leading-[1.04] text-ink md:text-[54px]">{title}</h2>
      {lead && <p className={`mt-4 text-[16px] leading-relaxed text-muted ${center ? "mx-auto max-w-xl" : "max-w-xl"}`}>{lead}</p>}
    </Reveal>
  );
}
