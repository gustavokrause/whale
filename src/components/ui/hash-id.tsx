"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function HashId({ id, className }: { id: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard?.writeText(id);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — skip swap */
    }
  };

  const short = id.length > 8 ? `${id.slice(0, 8)}…` : id;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded bg-border text-text-2",
        className,
      )}
      title={id}
    >
      {short}
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy ID"}
        className="inline-flex items-center text-text-3 hover:text-text"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
