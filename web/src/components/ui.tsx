"use client";

import clsx from "clsx";
import { animate, useReducedMotion } from "framer-motion";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import { Backdrop } from "@/components/landing/FluidField";

/** A number that glides to its new value instead of jumping. */
export function Num({ value, format }: { value: number; format: (v: number) => string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduce || !Number.isFinite(value) || !Number.isFinite(from.current)) {
      from.current = value;
      setShown(value);
      return;
    }
    const c = animate(from.current, value, {
      duration: 0.7,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (v) => {
        from.current = v;
        setShown(v);
      },
    });
    return () => c.stop();
  }, [value, reduce]);
  return <>{format(shown)}</>;
}

type Tone = "neutral" | "pass" | "breach" | "warn" | "accent";
const toneText: Record<Tone, string> = {
  neutral: "text-muted",
  pass: "text-pass",
  breach: "text-breach",
  warn: "text-warn",
  accent: "text-accent",
};
const toneBg: Record<Tone, string> = {
  neutral: "bg-muted",
  pass: "bg-pass",
  breach: "bg-breach",
  warn: "bg-warn",
  accent: "bg-accent",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-6 text-[15px]",
        variant === "primary" && "bg-ink text-bg hover:bg-ink/85",
        variant === "secondary" && "border border-line-strong text-ink hover:border-muted hover:bg-raised",
        variant === "ghost" && "text-muted hover:bg-raised hover:text-ink",
        variant === "danger" && "border border-breach/50 text-breach hover:border-breach hover:bg-breach/10",
        className,
      )}
    />
  );
}

export function Panel({
  title,
  eyebrow,
  action,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={clsx("rounded-lg border border-line bg-surface shadow-[var(--shadow)]", className)}>
      {(title || eyebrow || action) && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && <h2 className="mt-0.5 text-[15px] font-medium text-ink">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, unit, sub, tone }: { label: ReactNode; value: ReactNode; unit?: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className={clsx("num mt-1 truncate text-[22px] leading-7", tone ? toneText[tone] : "text-ink")}>
        {value}
        {unit && <span className="ml-1.5 text-[13px] text-faint">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[13px] text-muted">{sub}</div>}
    </div>
  );
}

/** A thin bar with an optional threshold mark. value and mark are 0..1. */
export function Meter({ value, mark, tone = "neutral", label }: { value: number; mark?: number; tone?: Tone; label?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative h-1.5 w-full rounded-full bg-line" role="meter" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={clsx("h-full rounded-full transition-[width] duration-300 ease-out", toneBg[tone])} style={{ width: `${v * 100}%` }} />
      {mark !== undefined && (
        <div className="absolute -top-1 h-3.5 w-px bg-ink" style={{ left: `${Math.max(0, Math.min(1, mark)) * 100}%` }} aria-hidden />
      )}
    </div>
  );
}

export function Tag({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded border px-2 text-[11px] font-medium uppercase tracking-[0.08em]",
        tone === "neutral" && "border-line-strong text-muted",
        tone === "pass" && "border-pass/40 text-pass",
        tone === "breach" && "border-breach/50 text-breach",
        tone === "warn" && "border-warn/50 text-warn",
        tone === "accent" && "border-accent/50 text-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={clsx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", toneBg[tone])} aria-hidden />;
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line-strong p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "h-8 rounded px-3 text-[13px] font-medium transition-colors",
            o.value === value ? "bg-ink text-bg" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  display,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  display: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted">{label}</span>
        <span className="num text-sm text-ink">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      {hint && <div className="text-xs text-faint">{hint}</div>}
    </label>
  );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 text-sm last:border-b-0">
      <span className="text-muted">{label}</span>
      <span className="num text-right text-ink">{children}</span>
    </div>
  );
}

export function PageHeader({ eyebrow, title, lead, aside }: { eyebrow: string; title: ReactNode; lead?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="relative isolate flex flex-col gap-5 pb-7 pt-9 md:flex-row md:items-end md:justify-between">
      <Backdrop />
      <div className="max-w-2xl">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="display mt-2 text-[40px] leading-[1.05] text-ink md:text-[48px]">{title}</h1>
        {lead && <p className="mt-3 text-[15px] leading-relaxed text-muted">{lead}</p>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </header>
  );
}
