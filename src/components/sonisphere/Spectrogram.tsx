import { useEffect, useRef } from "react";

interface Props {
  frames: Float32Array[];
  binHz: number;
  height?: number;
}

/** Aurora-tinted heatmap of the log spectrogram. */
export function Spectrogram({ frames, binHz, height = 190 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || frames.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);

    const bins = frames[0]!.length;
    const colW = w / frames.length;

    for (let f = 0; f < frames.length; f++) {
      const frame = frames[f]!;
      for (let k = 0; k < bins; k += 1) {
        const v = frame[k]!;
        if (v < 0.12) continue;
        const y = height - (k / bins) * height;
        // aurora ramp: teal -> violet -> amber
        const hue = 178 - v * 120 + (k / bins) * 90;
        ctx.fillStyle = `hsl(${hue} 85% ${28 + v * 45}% / ${Math.min(1, v * 1.35)})`;
        ctx.fillRect(f * colW, y - height / bins, Math.max(1, colW + 0.6), height / bins + 0.6);
      }
    }
  }, [frames, height]);

  const maxHz = Math.round((frames[0]?.length ?? 0) * binHz);

  return (
    <div className="relative">
      <canvas ref={ref} style={{ height, width: "100%" }} className="rounded-xl bg-background/50" />
      <div className="pointer-events-none absolute left-2 top-2 mono-num text-[10px] text-muted-foreground">
        {(maxHz / 1000).toFixed(1)} kHz
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 mono-num text-[10px] text-muted-foreground">
        0 Hz
      </div>
    </div>
  );
}
