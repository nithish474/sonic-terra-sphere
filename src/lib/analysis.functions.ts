import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MetricsSchema = z.object({
  durationSec: z.number(),
  aci: z.number(),
  rt60: z.number(),
  sri: z.number(),
  dominantHz: z.number(),
  bandwidthHz: z.number(),
  peakDb: z.number(),
  syllables: z.number(),
  noiseFloorRatio: z.number(),
});

const InputSchema = z.object({
  audioBase64: z.string().min(16).max(9_000_000),
  format: z.enum(["webm", "m4a", "wav", "mp3", "ogg"]),
  metrics: MetricsSchema,
  region: z.string().max(120).optional(),
});

export type AcousticVerdict = {
  species: string;
  commonName: string;
  confidence: number;
  alternatives: { name: string; confidence: number }[];
  soundscape: string;
  environmentReading: string;
  sriInterpretation: string;
  matingReadiness: number;
  alerts: string[];
  error?: string;
};

const fallback = (error: string): AcousticVerdict => ({
  species: "Unresolved",
  commonName: "No confident match",
  confidence: 0,
  alternatives: [],
  soundscape: "The acoustic layer was measured locally, but the AI read-out is unavailable.",
  environmentReading: "Physical metrics below are still valid — they are computed on-device.",
  sriInterpretation: "",
  matingReadiness: 0,
  alerts: [],
  error,
});

export const analyzeCapture = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }): Promise<AcousticVerdict> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) return fallback("AI gateway key is not configured.");

    const m = data.metrics;
    const prompt = [
      "You are SoniSphere, a bioacoustics + micro-acoustic-tomography analyst.",
      "Listen to the attached field recording and combine it with the on-device DSP measurements.",
      "",
      `Duration: ${m.durationSec.toFixed(1)} s`,
      `Acoustic Complexity Index: ${m.aci}`,
      `Reverberation RT60: ${m.rt60} s`,
      `Soil Rigidity Index (0-100): ${m.sri}`,
      `Dominant frequency: ${m.dominantHz} Hz`,
      `Spectral bandwidth: ${m.bandwidthHz} Hz`,
      `Peak level: ${m.peakDb} dBFS`,
      `Detected syllable onsets: ${m.syllables}`,
      `Low-frequency (<500 Hz) energy share: ${m.noiseFloorRatio}`,
      data.region ? `Approximate region: ${data.region}` : "",
      "",
      "Rules: if no bird is audible, say so plainly and describe the room/space acoustics instead.",
      "matingReadiness is 0-100 from syllable diversity and call complexity; use 0 when no bird is present.",
      "alerts: short strings only for genuine concerns (e.g. gunshot-like transient, sudden silence, heavy anthropogenic noise). Empty array otherwise.",
      "Respond in JSON only.",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": apiKey,
          "X-Lovable-AIG-SDK": "fetch",
        },
        body: JSON.stringify({
          model: "google/gemini-3.7-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "input_audio",
                  input_audio: { data: data.audioBase64, format: data.format },
                },
              ],
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "sonisphere_verdict",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  species: { type: "string" },
                  commonName: { type: "string" },
                  confidence: { type: "number" },
                  alternatives: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        name: { type: "string" },
                        confidence: { type: "number" },
                      },
                      required: ["name", "confidence"],
                    },
                  },
                  soundscape: { type: "string" },
                  environmentReading: { type: "string" },
                  sriInterpretation: { type: "string" },
                  matingReadiness: { type: "number" },
                  alerts: { type: "array", items: { type: "string" } },
                },
                required: [
                  "species",
                  "commonName",
                  "confidence",
                  "alternatives",
                  "soundscape",
                  "environmentReading",
                  "sriInterpretation",
                  "matingReadiness",
                  "alerts",
                ],
              },
            },
          },
        }),
      });

      if (res.status === 429) return fallback("AI is rate limited right now — try again in a moment.");
      if (res.status === 402) return fallback("AI credits are exhausted for this workspace.");
      if (!res.ok) {
        console.error("AI gateway error", res.status, await res.text());
        return fallback(`AI analysis failed (${res.status}).`);
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return fallback("AI returned an empty response.");
      const parsed = JSON.parse(content) as AcousticVerdict;
      return { ...parsed, confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)) };
    } catch (err) {
      console.error("analyzeCapture failed", err);
      return fallback("AI analysis could not be completed.");
    }
  });
