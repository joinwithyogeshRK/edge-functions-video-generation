// ============================================================
//  Supabase Edge Function: video-transcript
//  Deploy path: supabase/functions/video-transcript/index.ts
//
//  Production-ready transcript agent:
//  - YouTube, TikTok, Instagram, Facebook, Twitter URLs
//  - Direct video/audio file URLs (mp4, mp3, wav etc)
//  - Uses Supadata API — handles all platforms reliably
//  - Falls back to AssemblyAI for direct file URLs
//  - Optionally summarizes with Claude (Anthropic)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Types ────────────────────────────────────────────────
interface TranscriptRequest {
  anthropic_api_key: string; // REQUIRED — for Claude summarization
  supadata_api_key: string; // REQUIRED — get free at supadata.ai (100 free/month)
  assemblyai_api_key?: string; // OPTIONAL — only for direct file URLs (mp4, mp3 etc)
  video_url: string; // REQUIRED — any platform URL or direct file URL
  language?: string; // OPTIONAL — e.g "en", "hi", "fr" — default: auto detect
  summarize?: boolean; // OPTIONAL — Claude summarizes transcript — default: false
}

interface SupadataSegment {
  text: string;
  offset: number; // start time in ms
  duration: number; // duration in ms
  lang: string;
}

interface SupadataResponse {
  content: SupadataSegment[] | string;
  lang: string;
  availableLangs?: string[];
}

// ─── Platform detection ───────────────────────────────────
function detectPlatform(url: string): "social" | "direct" {
  const socialPlatforms = [
    "youtube.com",
    "youtu.be",
    "tiktok.com",
    "instagram.com",
    "facebook.com",
    "fb.com",
    "twitter.com",
    "x.com",
  ];
  return socialPlatforms.some((p) => url.includes(p)) ? "social" : "direct";
}

// ─── Supadata: get transcript from any social platform URL ─
async function getTranscriptFromSupadata(
  videoUrl: string,
  apiKey: string,
  language?: string,
): Promise<{
  text: string;
  segments: { start: number; duration: number; text: string }[];
  lang: string;
  availableLangs: string[];
}> {
  // Build URL — use text=false to get segments with timestamps
  const params = new URLSearchParams({ url: videoUrl });
  if (language) params.set("lang", language);

  console.log(`[transcript] Calling Supadata for: ${videoUrl}`);

  const res = await fetch(`https://api.supadata.ai/v1/transcript?${params}`, {
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
  });

  // Handle async job (videos > 20 min return 202 with job ID)
  if (res.status === 202) {
    const { jobId } = await res.json();
    console.log(`[transcript] Supadata async job: ${jobId} — polling...`);
    return await pollSupadataJob(jobId, apiKey);
  }

  if (res.status === 404) {
    throw new Error(
      "Video not found or is private. Make sure the video is publicly accessible.",
    );
  }

  if (res.status === 206) {
    throw new Error(
      "This video has no captions available. Pass an assemblyai_api_key to transcribe it via AI instead.",
    );
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supadata API error (${res.status}): ${err}`);
  }

  const data: SupadataResponse = await res.json();
  return parseSupadataResponse(data);
}

// ─── Poll Supadata async job (for videos > 20 min) ────────
async function pollSupadataJob(
  jobId: string,
  apiKey: string,
  maxWaitMs = 15 * 60 * 1000,
  intervalMs = 8_000,
): Promise<{
  text: string;
  segments: { start: number; duration: number; text: string }[];
  lang: string;
  availableLangs: string[];
}> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
      headers: { "x-api-key": apiKey },
    });

    if (!res.ok) throw new Error(`Supadata poll failed: ${await res.text()}`);

    const data = await res.json();
    console.log(
      `[transcript] Supadata job status: ${data.status ?? "processing"}`,
    );

    if (data.content) {
      return parseSupadataResponse(data);
    }

    if (data.status === "failed") {
      throw new Error(`Supadata job failed: ${data.error ?? "Unknown error"}`);
    }
  }

  throw new Error("Supadata job timed out (15 min limit).");
}

// ─── Parse Supadata response into clean format ────────────
function parseSupadataResponse(data: SupadataResponse): {
  text: string;
  segments: { start: number; duration: number; text: string }[];
  lang: string;
  availableLangs: string[];
} {
  // content can be string (text=true) or array of segments (text=false)
  if (typeof data.content === "string") {
    return {
      text: data.content,
      segments: [],
      lang: data.lang,
      availableLangs: data.availableLangs ?? [],
    };
  }

  const segments = (data.content as SupadataSegment[])
    .map((s) => ({
      start: s.offset / 1000, // ms → seconds
      duration: s.duration / 1000, // ms → seconds
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0);

  const text = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    text,
    segments,
    lang: data.lang,
    availableLangs: data.availableLangs ?? [],
  };
}

// ─── AssemblyAI: transcribe direct file URLs ───────────────
async function transcribeWithAssemblyAI(
  audioUrl: string,
  apiKey: string,
  language = "en",
): Promise<{
  text: string;
  segments: { start: number; duration: number; text: string }[];
}> {
  console.log(`[transcript] Submitting to AssemblyAI: ${audioUrl}`);

  const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: ["universal-2"],
      language_code: language,
      punctuate: true,
      format_text: true,
    }),
  });

  if (!submitRes.ok)
    throw new Error(`AssemblyAI submit failed: ${await submitRes.text()}`);
  const { id: jobId } = await submitRes.json();
  console.log(`[transcript] AssemblyAI job: ${jobId}`);

  // Poll until done
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6_000));

    const pollRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${jobId}`,
      {
        headers: { authorization: apiKey },
      },
    );

    if (!pollRes.ok)
      throw new Error(`AssemblyAI poll failed: ${await pollRes.text()}`);

    const data = await pollRes.json();
    console.log(`[transcript] AssemblyAI status: ${data.status}`);

    if (data.status === "completed") {
      const segments = (data.words ?? []).map((w: any) => ({
        start: w.start / 1000,
        duration: (w.end - w.start) / 1000,
        text: w.text,
      }));
      return { text: data.text, segments };
    }

    if (data.status === "error") {
      throw new Error(`AssemblyAI error: ${data.error}`);
    }
  }

  throw new Error("AssemblyAI timed out (15 min limit).");
}

// ─── Claude: summarize transcript ─────────────────────────
async function summarizeWithClaude(
  transcript: string,
  apiKey: string,
): Promise<string> {
  // Truncate very long transcripts to stay within Claude context
  const maxChars = 30_000;
  const truncated =
    transcript.length > maxChars
      ? transcript.slice(0, maxChars) + "\n\n[Transcript truncated for length]"
      : transcript;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Here is a video transcript. Please provide:
1. A concise summary (3-5 sentences)
2. Key points (bullet points)
3. Main topics covered

Transcript:
${truncated}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

// ─── Main handler ─────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST is allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Parse & validate ────────────────────────────
    const body: TranscriptRequest = await req.json();
    const {
      anthropic_api_key,
      supadata_api_key,
      assemblyai_api_key,
      video_url,
      language,
      summarize = false,
    } = body;

    if (!anthropic_api_key?.trim()) {
      return new Response(
        JSON.stringify({ error: "anthropic_api_key is required" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }
    if (!supadata_api_key?.trim()) {
      return new Response(
        JSON.stringify({
          error:
            "supadata_api_key is required. Get 100 free requests at supadata.ai",
        }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }
    if (!video_url?.trim()) {
      return new Response(JSON.stringify({ error: "video_url is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Basic URL validation
    try {
      new URL(video_url);
    } catch {
      return new Response(
        JSON.stringify({ error: "video_url is not a valid URL" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // ── 2. Detect platform and get transcript ──────────
    const platform = detectPlatform(video_url);
    let text: string;
    let segments: { start: number; duration: number; text: string }[];
    let source: string;
    let lang: string;
    let availableLangs: string[];

    if (platform === "social") {
      // YouTube, TikTok, Instagram, Facebook, Twitter — use Supadata
      console.log(`[transcript] Social platform detected — using Supadata`);
      const result = await getTranscriptFromSupadata(
        video_url,
        supadata_api_key,
        language,
      );
      text = result.text;
      segments = result.segments;
      source = "supadata";
      lang = result.lang;
      availableLangs = result.availableLangs;
    } else {
      // Direct file URL (mp4, mp3, wav, webm etc) — use AssemblyAI
      if (!assemblyai_api_key?.trim()) {
        return new Response(
          JSON.stringify({
            error:
              "assemblyai_api_key is required for direct file URLs (mp4, mp3, wav etc). Get free key at assemblyai.com",
          }),
          {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          },
        );
      }

      console.log(`[transcript] Direct file URL detected — using AssemblyAI`);
      const result = await transcribeWithAssemblyAI(
        video_url,
        assemblyai_api_key,
        language ?? "en",
      );
      text = result.text;
      segments = result.segments;
      source = "assemblyai";
      lang = language ?? "en";
      availableLangs = [lang];
    }

    if (!text?.trim()) {
      throw new Error(
        "Transcript came back empty. The video may have no audio or captions.",
      );
    }

    // ── 3. Optionally summarize with Claude ────────────
    let summary = null;
    if (summarize) {
      console.log(`[transcript] Summarizing with Claude...`);
      summary = await summarizeWithClaude(text, anthropic_api_key);
    }

    // ── 4. Return response ─────────────────────────────
    return new Response(
      JSON.stringify({
        success: true,
        source, // "supadata" or "assemblyai"
        lang, // detected language code e.g "en"
        available_langs: availableLangs, // other languages available for this video
        transcript: text, // full clean transcript
        word_count: text.split(" ").filter(Boolean).length,
        segments, // [{ start, duration, text }] with timestamps in seconds
        summary, // null unless summarize: true
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[transcript] Error:", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Unexpected error",
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }
});
