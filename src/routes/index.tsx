import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { analyzeCapture, type AcousticVerdict } from "@/lib/analysis.functions";
import { analyzeBuffer, decodeBlob, ecosystemVerdict, encodeWav, type AcousticMetrics } from "@/lib/dsp";
import { Orb } from "@/components/sonisphere/Orb";
import { Spectrogram } from "@/components/sonisphere/Spectrogram";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SoniSphere — Birds as Environmental Sensors" },
      {
        name: "description",
        content:
          "SoniSphere turns a 15-second field recording into species identification, acoustic complexity, reverberation decay and a live Soil Rigidity Index.",
      },
      { property: "og:title", content: "SoniSphere — Birds as Environmental Sensors" },
      {
        property: "og:description",
        content:
          "Record a soundscape and get species ID, ecosystem health, dawn-chorus metrics and subsurface soil rigidity from one tap.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

const CAPTURE_MS = 15_000;

interface Capture {
  metrics: AcousticMetrics;
  buffer: AudioBuffer;
  verdict: AcousticVerdict | null;
}

interface SavedRow {
  id: string;
  label: string;
  species: string | null;
  confidence: number | null;
  aci: number | null;
  sri: number | null;
  rt60: number | null;
  created_at: string;
}

function Home() {
  const { session, user, loading } = useSession();
  const navigate = useNavigate();
  const analyze = useServerFn(analyzeCapture);

  const [state, setState] = useState<"idle" | "recording" | "analyzing">("idle");
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [rows, setRows] = useState<SavedRow[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const rafRef = useRef<number | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRows = useCallback(async () => {
    const { data, error } = await supabase
      .from("recordings")
      .select("id,label,species,confidence,aci,sri,rt60,created_at")
      .order("created_at", { ascending: false })
      .limit(12);
    if (!error && data) setRows(data as SavedRow[]);
  }, []);

  useEffect(() => {
    if (session) void loadRows();
  }, [session, loadRows]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    };
  }, []);

  const stopRecording = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });

      const AudioCtx: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

      const started = performance.now();
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        setElapsed((performance.now() - started) / 1000);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      recorder.onstop = async () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        setLevel(0);
        setState("analyzing");

        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        try {
          const buffer = await decodeBlob(blob);
          const metrics = analyzeBuffer(buffer);
          setCapture({ metrics, buffer, verdict: null });

          const base64 = await blobToBase64(blob);
          const format = (recorder.mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm";
          const verdict = await analyze({
            data: { audioBase64: base64, format, metrics: pickMetrics(metrics) },
          });
          setCapture({ metrics, buffer, verdict });
          if (verdict.error) toast.error(verdict.error);
        } catch (err) {
          console.error(err);
          toast.error("Could not decode that capture. Try again.");
        } finally {
          setState("idle");
        }
      };

      recorder.start();
      setState("recording");
      setElapsed(0);
      stopTimerRef.current = setTimeout(() => stopRecording(), CAPTURE_MS);
    } catch (err) {
      console.error(err);
      toast.error("Microphone access is required to capture a soundscape.");
      setState("idle");
    }
  }, [analyze, stopRecording]);

  const onOrb = () => {
    if (state === "recording") stopRecording();
    else if (state === "idle") void startRecording();
  };

  async function save() {
    if (!capture || !user) return;
    const m = capture.metrics;
    const v = capture.verdict;
    const { error } = await supabase.from("recordings").insert({
      user_id: user.id,
      label: v?.commonName && v.commonName !== "No confident match" ? v.commonName : "Field capture",
      duration_sec: m.durationSec,
      aci: m.aci,
      reverb_rt60: m.rt60,
      sri: m.sri,
      dominant_hz: m.dominantHz,
      peak_db: m.peakDb,
      bandwidth_hz: m.bandwidthHz,
      species: v?.species ?? null,
      confidence: v?.confidence ?? null,
      ai_summary: v?.soundscape ?? null,
      ai_json: v ? JSON.parse(JSON.stringify(v)) : null,
    });
    if (error) return toast.error(error.message);
    toast.success("Capture archived to your field log.");
    void loadRows();
  }

  function exportWav() {
    if (!capture) return;
    const url = URL.createObjectURL(encodeWav(capture.buffer));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sonisphere-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    if (!capture) return;
    const m = capture.metrics;
    const v = capture.verdict;
    const csv = [
      "field,value",
      `duration_sec,${m.durationSec.toFixed(2)}`,
      `sample_rate,${m.sampleRate}`,
      `aci,${m.aci}`,
      `rt60_sec,${m.rt60}`,
      `soil_rigidity_index,${m.sri}`,
      `dominant_hz,${m.dominantHz}`,
      `bandwidth_hz,${m.bandwidthHz}`,
      `peak_dbfs,${m.peakDb}`,
      `syllable_onsets,${m.syllables}`,
      `low_freq_share,${m.noiseFloorRatio}`,
      `species,"${v?.species ?? ""}"`,
      `confidence,${v?.confidence ?? ""}`,
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sonisphere-metrics-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const eco = useMemo(() => (capture ? ecosystemVerdict(capture.metrics) : null), [capture]);
  const sriTrend = useMemo(() => rows.slice().reverse().map((r) => Number(r.sri ?? 0)), [rows]);

  return (
    <main className="relative mx-auto min-h-screen w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <header className="glass flex flex-wrap items-center justify-between gap-4 rounded-2xl px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="glow flex h-9 w-9 items-center justify-center rounded-full aurora-fill text-sm font-bold text-primary-foreground">
            S
          </span>
          <div>
            <p className="font-display text-base font-semibold leading-none">SoniSphere</p>
            <p className="text-[11px] text-muted-foreground">Ecosystem stethoscope</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {loading ? null : session ? (
            <>
              <span className="hidden text-xs text-muted-foreground sm:inline">{user?.email}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await supabase.auth.signOut();
                  toast.success("Signed out.");
                }}
              >
                Sign out
              </Button>
            </>
          ) : (
            <Button variant="hero" size="sm" onClick={() => navigate({ to: "/auth" })}>
              Sign in
            </Button>
          )}
        </div>
      </header>

      <section className="mt-10 flex flex-col items-center text-center">
        <p className="mono-num text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          Micro-Acoustic Tomography
        </p>
        <h1 className="mt-3 max-w-2xl text-4xl font-semibold sm:text-5xl">
          Birds aren't data points. They're <span className="aurora-text">live environmental sensors</span>.
        </h1>
        <p className="mt-4 max-w-xl text-sm text-muted-foreground sm:text-base">
          One tap captures 15 seconds of the world around you. SoniSphere measures how the physical environment is
          bending that voice — complexity, reverberation decay, and subsurface soil rigidity.
        </p>

        <div className="mt-6">
          <Orb state={state} level={level} seconds={elapsed} onClick={onOrb} />
        </div>
      </section>

      {capture && (
        <section className="mt-10 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Acoustic Complexity" value={capture.metrics.aci.toFixed(1)} hint="ACI — higher = richer" />
            <Metric label="Reverb decay" value={`${capture.metrics.rt60.toFixed(2)} s`} hint="RT60, Schroeder T20 fit" />
            <Metric
              label="Soil Rigidity Index"
              value={capture.metrics.sri.toFixed(1)}
              hint="0 = loose / saturated · 100 = compacted"
              accent
            />
            <Metric
              label="Ecosystem"
              value={eco?.label ?? "—"}
              hint={`Health score ${eco?.score ?? 0}/100`}
            />
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">Spectrogram</h2>
              <span className="mono-num text-xs text-muted-foreground">
                {capture.metrics.dominantHz} Hz dominant · {capture.metrics.syllables} syllables ·{" "}
                {capture.metrics.peakDb.toFixed(1)} dBFS
              </span>
            </div>
            <Spectrogram frames={capture.metrics.spectrogram} binHz={capture.metrics.binHz} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="glass rounded-2xl p-5">
              <h2 className="font-display text-lg font-semibold">AI read-out</h2>
              {state === "analyzing" && !capture.verdict ? (
                <p className="mt-3 text-sm text-muted-foreground">Listening back through the model…</p>
              ) : capture.verdict ? (
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <p className="font-display text-xl">{capture.verdict.commonName}</p>
                      <p className="text-xs italic text-muted-foreground">{capture.verdict.species}</p>
                    </div>
                    <span className="mono-num rounded-full border border-border px-3 py-1 text-xs">
                      {capture.verdict.confidence.toFixed(0)}% confidence
                    </span>
                  </div>
                  <p className="text-muted-foreground">{capture.verdict.soundscape}</p>
                  <p className="text-muted-foreground">{capture.verdict.environmentReading}</p>
                  {capture.verdict.sriInterpretation && (
                    <p className="rounded-xl border border-border/60 bg-background/40 p-3 text-xs text-muted-foreground">
                      <span className="text-foreground">Geology layer: </span>
                      {capture.verdict.sriInterpretation}
                    </p>
                  )}
                  {capture.verdict.alternatives.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {capture.verdict.alternatives.map((a) => (
                        <span
                          key={a.name}
                          className="mono-num rounded-full bg-secondary px-3 py-1 text-[11px] text-secondary-foreground"
                        >
                          {a.name} · {a.confidence.toFixed(0)}%
                        </span>
                      ))}
                    </div>
                  )}
                  {capture.verdict.alerts.length > 0 && (
                    <ul className="space-y-1 pt-1">
                      {capture.verdict.alerts.map((a) => (
                        <li
                          key={a}
                          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
                        >
                          ⚠ {a}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>

            <div className="glass rounded-2xl p-5">
              <h2 className="font-display text-lg font-semibold">Mating readiness & export</h2>
              <div className="mt-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Call complexity score</span>
                  <span className="mono-num">{capture.verdict?.matingReadiness ?? 0}/100</span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full aurora-fill transition-all"
                    style={{ width: `${capture.verdict?.matingReadiness ?? 0}%` }}
                  />
                </div>
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                <Button variant="hero" size="sm" onClick={save} disabled={!session}>
                  {session ? "Archive capture" : "Sign in to archive"}
                </Button>
                <Button variant="outline" size="sm" onClick={exportWav}>
                  Export .wav
                </Button>
                <Button variant="outline" size="sm" onClick={exportCsv}>
                  Export metrics .csv
                </Button>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Exports are noise-profiled and timestamped for peer-reviewed workflows.
              </p>
            </div>
          </div>
        </section>
      )}

      {session && rows.length > 0 && (
        <section className="mt-12 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="glass rounded-2xl p-5">
            <h2 className="font-display text-lg font-semibold">Field log</h2>
            <div className="mt-4 space-y-2">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/50 bg-background/30 px-4 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{r.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()} · {r.species ?? "unresolved"}
                    </p>
                  </div>
                  <div className="mono-num flex gap-4 text-xs text-muted-foreground">
                    <span>ACI {Number(r.aci ?? 0).toFixed(1)}</span>
                    <span>RT60 {Number(r.rt60 ?? 0).toFixed(2)}s</span>
                    <span className="text-primary">SRI {Number(r.sri ?? 0).toFixed(1)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="glass rounded-2xl p-5">
            <h2 className="font-display text-lg font-semibold">SRI trend</h2>
            <p className="text-xs text-muted-foreground">Soil rigidity across your recent captures.</p>
            <Sparkline values={sriTrend} />
            <SriAlert values={sriTrend} />
          </div>
        </section>
      )}

      <footer className="mt-16 text-center text-xs text-muted-foreground">
        Acoustic metrics are computed on-device. SRI is a research indicator, not a certified geohazard instrument.
      </footer>
    </main>
  );
}

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className={cn("glass rounded-2xl p-4", accent && "glow")}>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mono-num mt-2 text-2xl font-semibold", accent && "aurora-text")}>{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <p className="mt-6 text-xs text-muted-foreground">Need two captures to plot a trend.</p>;
  const max = Math.max(...values, 1);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${40 - (v / max) * 36}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mt-4 h-24 w-full">
      <polyline points={pts} fill="none" stroke="var(--aurora-1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function SriAlert({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const last = values[values.length - 1]!;
  const prev = values[values.length - 2]!;
  const drop = prev > 0 ? ((prev - last) / prev) * 100 : 0;
  if (drop < 5) {
    return <p className="mt-2 text-xs text-muted-foreground">Stable — no significant rigidity loss detected.</p>;
  }
  return (
    <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
      ⚠ SRI dropped {drop.toFixed(1)}% since the previous capture — possible soil loosening.
    </p>
  );
}

function pickMetrics(m: AcousticMetrics) {
  return {
    durationSec: m.durationSec,
    aci: m.aci,
    rt60: m.rt60,
    sri: m.sri,
    dominantHz: m.dominantHz,
    bandwidthHz: m.bandwidthHz,
    peakDb: m.peakDb,
    syllables: m.syllables,
    noiseFloorRatio: m.noiseFloorRatio,
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}
