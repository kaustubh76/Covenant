"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import { type Address, isAddress } from "viem";

/** What an address field holds: nothing yet, an address, or text that is not one (strict: mixed case must checksum). */
export function parseAddress(text: string): { address: Address | null; bad: boolean } {
  const t = text.trim();
  if (t === "") return { address: null, bad: false };
  return isAddress(t) ? { address: t, bad: false } : { address: null, bad: true };
}

/** A labelled 0x… field that says when the text is not an address. The caller reads the value with `parseAddress`. */
export function AddressInput({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: ReactNode;
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const { bad } = parseAddress(value);
  return (
    <label className={clsx("block text-[13px] text-muted", className)}>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={bad}
        className={clsx(
          "num mt-1.5 h-9 w-full rounded-md border bg-transparent px-2.5 text-[13px] text-ink outline-none placeholder:text-faint",
          bad ? "border-breach/60" : "border-line-strong focus:border-muted",
        )}
      />
      {bad && <span className="mt-1 block text-xs text-breach">That is not an address.</span>}
    </label>
  );
}
