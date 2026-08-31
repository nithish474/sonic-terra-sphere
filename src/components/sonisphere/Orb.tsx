import { cn } from "@/lib/utils";

interface OrbProps {
  state: "idle" | "recording" | "analyzing";
  level: number;
  seconds: number;
  onClick: () => void;
}

export function Orb({ state, level, seconds, onClick }: OrbProps) {
  const scale = 1 + Math.min(0.28, level * 0.55);

  return (
    <div className="relative flex h-72 w-72 items-center justify-center sm:h-80 sm:w-80">
      <div className="animate-aurora pointer-events-none absolute inset-0 rounded-full opacity-45 blur-3xl aurora-fill" />
      {state === "recording" && (
        <>
          <span className="animate-ring pointer-events-none absolute h-52 w-52 rounded-full border border-primary/50" />
          <span
            className="animate-ring pointer-events-none absolute h-52 w-52 rounded-full border border-accent/40"
            style={{ animationDelay: "0.9s" }}
          />
        </>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={state === "analyzing"}
        aria-label={state === "recording" ? "Stop listening" : "Start listening"}
        className={cn(
          "glass glow group relative flex h-48 w-48 flex-col items-center justify-center rounded-full transition-transform duration-150 sm:h-56 sm:w-56",
          state === "idle" && "animate-orb hover:scale-105",
          state === "analyzing" && "cursor-wait opacity-80",
        )}
        style={state === "recording" ? { transform: `scale(${scale})` } : undefined}
      >
        <span
          className="pointer-events-none absolute inset-4 rounded-full opacity-70 blur-xl aurora-fill"
          style={{ opacity: 0.25 + level * 0.5 }}
        />
        <span className="relative font-display text-3xl font-semibold tracking-tight">
          {state === "recording" ? (
            <span className="mono-num">{seconds.toFixed(1)}s</span>
          ) : state === "analyzing" ? (
            "Analyzing"
          ) : (
            "Listen"
          )}
        </span>
        <span className="relative mt-1 max-w-[10rem] text-center text-xs text-muted-foreground">
          {state === "recording"
            ? "Tap to stop"
            : state === "analyzing"
              ? "Running acoustic tomography"
              : "Tap the orb to capture 15s"}
        </span>
      </button>
    </div>
  );
}
