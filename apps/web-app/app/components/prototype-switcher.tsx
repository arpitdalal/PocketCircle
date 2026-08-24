import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { Button } from "~/components/ui/button.js";

const VARIANTS = [
  { key: "A", name: "Context first" },
  { key: "B", name: "Two pane" },
  { key: "C", name: "Progressive reveal" },
] as const;

export type PrototypeVariant = (typeof VARIANTS)[number]["key"];

export function readPrototypeVariant(value: string | null) {
  return VARIANTS.find((variant) => variant.key === value)?.key ?? "A";
}

export function PrototypeSwitcher({ current }: { current: PrototypeVariant }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentIndex = VARIANTS.findIndex((variant) => variant.key === current);

  const selectOffset = useCallback(
    (offset: number) => {
      const next = VARIANTS[(currentIndex + offset + VARIANTS.length) % VARIANTS.length];
      if (!next) return;
      const params = new URLSearchParams(searchParams);
      params.set("variant", next.key);
      setSearchParams(params, { replace: true });
    },
    [currentIndex, searchParams, setSearchParams],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") selectOffset(-1);
      if (event.key === "ArrowRight") selectOffset(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectOffset]);

  if (import.meta.env.PROD) return null;
  const active = VARIANTS[currentIndex] ?? VARIANTS[0];

  return (
    <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground p-1.5 text-background shadow-xl">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-background hover:bg-background/15 hover:text-background"
        onClick={() => selectOffset(-1)}
        aria-label="Previous prototype variant"
      >
        <ArrowLeft aria-hidden />
      </Button>
      <span className="min-w-40 text-center text-xs font-semibold">
        {active.key} · {active.name}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-background hover:bg-background/15 hover:text-background"
        onClick={() => selectOffset(1)}
        aria-label="Next prototype variant"
      >
        <ArrowRight aria-hidden />
      </Button>
    </div>
  );
}
