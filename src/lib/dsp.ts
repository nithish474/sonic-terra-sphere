/**
 * SoniSphere DSP engine — runs entirely in the browser on the decoded
 * AudioBuffer. No server round-trip is needed for the acoustic layer.
 *
 * Produces: mel-ish log spectrogram, Acoustic Complexity Index (ACI),
 * reverberation decay (RT60 via Schroeder backward integration),
 * dominant frequency, spectral bandwidth, peak level and the derived
 * Soil Rigidity Index (SRI).
 */

export const FFT_SIZE = 1024;
export const HOP = 512;
export const MAX_HZ = 12000;

/* ---------- radix-2 FFT (in-place, real input) ---------- */

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hann = (() => {
  const w = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  return w;
})();

export interface AcousticMetrics {
  durationSec: number;
  sampleRate: number;
  /** frames x bins, magnitude 0..1 (already log-scaled + normalised) */
  spectrogram: Float32Array[];
  binHz: number;
  binCount: number;
  aci: number;
  rt60: number;
  sri: number;
  dominantHz: number;
  bandwidthHz: number;
  peakDb: number;
  /** frame-level loudness envelope, 0..1 */
  envelope: Float32Array;
  /** rough count of distinct vocal "syllables" (envelope onsets) */
  syllables: number;
  /** 0..1 share of energy below 500 Hz — anthropogenic / wind proxy */
  noiseFloorRatio: number;
}

export function analyzeBuffer(buffer: AudioBuffer): AcousticMetrics {
  const sr = buffer.sampleRate;
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] = mono[i]! + d[i]! / ch;
  }

  const binHz = sr / FFT_SIZE;
  const binCount = Math.min(FFT_SIZE / 2, Math.floor(MAX_HZ / binHz));
  const frameCount = Math.max(1, Math.floor((n - FFT_SIZE) / HOP));

  const spectrogram: Float32Array[] = [];
  const magFrames: Float32Array[] = [];
  const envelope = new Float32Array(frameCount);

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let f = 0; f < frameCount; f++) {
    const off = f * HOP;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FFT_SIZE; i++) re[i] = (mono[off + i] ?? 0) * hann[i]!;
    fft(re, im);

    const mag = new Float32Array(binCount);
    const view = new Float32Array(binCount);
    let energy = 0;
    for (let k = 0; k < binCount; k++) {
      const m = Math.hypot(re[k]!, im[k]!) / (FFT_SIZE / 2);
      mag[k] = m;
      energy += m * m;
      // log scale to 0..1 across a 70 dB window
      const db = 20 * Math.log10(m + 1e-8);
      view[k] = Math.min(1, Math.max(0, (db + 80) / 70));
    }
    magFrames.push(mag);
    spectrogram.push(view);
    envelope[f] = Math.sqrt(energy / binCount);
  }

  /* ---- Acoustic Complexity Index (Pieretti et al.) ---- */
  let aciSum = 0;
  for (let k = 0; k < binCount; k++) {
    let diff = 0;
    let total = 0;
    for (let f = 0; f < frameCount; f++) {
      const v = magFrames[f]![k]!;
      total += v;
      if (f > 0) diff += Math.abs(v - magFrames[f - 1]![k]!);
    }
    if (total > 1e-9) aciSum += diff / total;
  }
  const aci = aciSum;

  /* ---- envelope normalisation, peak, syllables ---- */
  let envMax = 1e-9;
  for (let f = 0; f < frameCount; f++) envMax = Math.max(envMax, envelope[f]!);
  for (let f = 0; f < frameCount; f++) envelope[f] = envelope[f]! / envMax;

  let syllables = 0;
  let armed = true;
  for (let f = 1; f < frameCount; f++) {
    if (armed && envelope[f]! > 0.45) {
      syllables++;
      armed = false;
    } else if (!armed && envelope[f]! < 0.22) {
      armed = true;
    }
  }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]!));
  const peakDb = 20 * Math.log10(peak + 1e-8);

  /* ---- reverberation decay (Schroeder backward integration, T20) ---- */
  const rt60 = estimateRt60(envelope, HOP / sr);

  /* ---- spectral descriptors ---- */
  const avg = new Float32Array(binCount);
  for (let k = 0; k < binCount; k++) {
    let s = 0;
    for (let f = 0; f < frameCount; f++) s += magFrames[f]![k]!;
    avg[k] = s / frameCount;
  }
  let best = 0;
  let bestK = 0;
  let sumA = 0;
  let sumFA = 0;
  for (let k = 1; k < binCount; k++) {
    if (avg[k]! > best) {
      best = avg[k]!;
      bestK = k;
    }
    sumA += avg[k]!;
    sumFA += avg[k]! * k * binHz;
  }
  const centroid = sumA > 0 ? sumFA / sumA : 0;
  let spread = 0;
  for (let k = 1; k < binCount; k++) {
    const d = k * binHz - centroid;
    spread += avg[k]! * d * d;
  }
  const bandwidthHz = sumA > 0 ? Math.sqrt(spread / sumA) : 0;

  let lowE = 0;
  const lowBins = Math.max(1, Math.floor(500 / binHz));
  for (let k = 0; k < lowBins; k++) lowE += avg[k]!;
  const noiseFloorRatio = sumA > 0 ? lowE / sumA : 0;

  return {
    durationSec: n / sr,
    sampleRate: sr,
    spectrogram,
    binHz,
    binCount,
    aci: round(aci, 2),
    rt60: round(rt60, 3),
    sri: soilRigidityIndex(rt60, noiseFloorRatio, bandwidthHz),
    dominantHz: Math.round(bestK * binHz),
    bandwidthHz: Math.round(bandwidthHz),
    peakDb: round(peakDb, 1),
    envelope,
    syllables,
    noiseFloorRatio: round(noiseFloorRatio, 3),
  };
}

/**
 * T20-style estimate: backward-integrate the squared envelope, then fit the
 * -5 dB → -25 dB slope and extrapolate to -60 dB.
 */
function estimateRt60(envelope: Float32Array, frameSec: number): number {
  const n = envelope.length;
  if (n < 8) return 0;
  let peakIdx = 0;
  for (let i = 0; i < n; i++) if (envelope[i]! > envelope[peakIdx]!) peakIdx = i;

  const tail = envelope.subarray(peakIdx);
  const m = tail.length;
  if (m < 6) return 0;

  const schroeder = new Float32Array(m);
  let acc = 0;
  for (let i = m - 1; i >= 0; i--) {
    acc += tail[i]! * tail[i]!;
    schroeder[i] = acc;
  }
  const ref = schroeder[0]! || 1e-12;
  const db = new Float32Array(m);
  for (let i = 0; i < m; i++) db[i] = 10 * Math.log10(schroeder[i]! / ref + 1e-12);

  let i5 = -1;
  let i25 = -1;
  for (let i = 0; i < m; i++) {
    if (i5 < 0 && db[i]! <= -5) i5 = i;
    if (i25 < 0 && db[i]! <= -25) {
      i25 = i;
      break;
    }
  }
  if (i5 < 0 || i25 < 0 || i25 <= i5) return 0;
  const slope = (db[i25]! - db[i5]!) / ((i25 - i5) * frameSec); // dB/s (negative)
  if (slope >= -1e-6) return 0;
  return Math.min(6, -60 / slope);
}

/**
 * Soil Rigidity Index (0–100). Hard, compacted ground reflects sound and
 * lengthens decay; loosening / saturated soil absorbs it and shortens decay
 * while raising low-frequency coupling.
 *
 *   SRI = 100 * (0.62 * norm(RT60) + 0.23 * (1 - lowFreqShare) + 0.15 * norm(bandwidth))
 */
export function soilRigidityIndex(rt60: number, lowFreqShare: number, bandwidthHz: number): number {
  const rNorm = clamp01(rt60 / 1.2);
  const bNorm = clamp01(bandwidthHz / 4000);
  const value = 0.62 * rNorm + 0.23 * (1 - clamp01(lowFreqShare)) + 0.15 * bNorm;
  return round(value * 100, 1);
}

export function ecosystemVerdict(m: AcousticMetrics) {
  const score = clamp01(m.aci / 240) * 0.5 + clamp01(m.syllables / 14) * 0.3 + (1 - clamp01(m.noiseFloorRatio)) * 0.2;
  if (score > 0.62) return { label: "Thriving", tone: "signal" as const, score: round(score * 100, 0) };
  if (score > 0.36) return { label: "Moderate", tone: "warning" as const, score: round(score * 100, 0) };
  return { label: "Stressed", tone: "destructive" as const, score: round(score * 100, 0) };
}

export function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

export function round(v: number, d: number) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  void ctx.close();
  return buf;
}

/** Encode an AudioBuffer as a 16-bit PCM WAV for researcher export. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const sr = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  out.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, n * ch * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]!));
      out.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}
