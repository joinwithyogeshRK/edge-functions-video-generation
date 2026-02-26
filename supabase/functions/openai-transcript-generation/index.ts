// ============================================================
//  Supabase Edge Function: video-transcript
//  Deploy path: supabase/functions/video-transcript/index.ts
//
//  Send a video URL (YouTube or direct) → get transcript back
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Request body ─────────────────────────────────────────
interface TranscriptRequest {
  openai_api_key: string; // REQUIRED — user's OpenAI API key
  video_url: string; // REQUIRED — YouTube or any direct video/audio URL
  language?: string; // optional — e.g. "en", "hi", "fr" — default: auto detect
}

// ─── Check if URL is YouTube ──────────────────────────────
function isYouTube(url: string): boolean {
  return (
    url.includes("youtube.com/watch") ||
    url.includes("youtu.be/") ||
    url.includes("youtube.com/shorts")
  );
}

// ─── Extract YouTube video ID ─────────────────────────────
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /youtube\.com\/shorts\/([^?]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ─── Get direct audio stream URL from YouTube ─────────────
// Uses the unofficial YouTube API to get audio stream
async function getYouTubeAudioUrl(
  videoId: string,
): Promise<{ url: string; title: string }> {
  // Use YouTube's innertube API to get video info
  const response = await fetch("https://www.youtube.com/youtubei/v1/player", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      "X-YouTube-Client-Name": "3",
      "X-YouTube-Client-Version": "17.31.35",
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "17.31.35",
          androidSdkVersion: 30,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch YouTube video info: ${response.status}`);
  }

  const data = await response.json();
  const title = data?.videoDetails?.title ?? "Unknown";

  // Get audio-only streams (itag 140 = m4a 128kbps, itag 251 = webm opus)
  const formats: any[] = data?.streamingData?.adaptiveFormats ?? [];
  const audioFormats = formats.filter(
    (f: any) => f.mimeType?.startsWith("audio/") && f.url,
  );

  if (!audioFormats.length) {
    throw new Error("No audio stream found for this YouTube video.");
  }

  // Prefer m4a (itag 140), fallback to first available
  const preferred =
    audioFormats.find((f: any) => f.itag === 140) ?? audioFormats[0];

  return { url: preferred.url, title };
}

// ─── Fetch audio as Blob (max 25MB — Whisper API limit) ───
async function fetchAudioBlob(
  url: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch audio from URL: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  const blob = await response.blob();

  // Whisper API limit is 25MB
  if (blob.size > 25 * 1024 * 1024) {
    throw new Error(
      `Audio file is too large (${(blob.size / 1024 / 1024).toFixed(1)}MB). Whisper API limit is 25MB.`,
    );
  }

  // Pick extension based on content type
  const ext =
    contentType.includes("mp4") || contentType.includes("m4a")
      ? "m4a"
      : contentType.includes("webm")
        ? "webm"
        : contentType.includes("wav")
          ? "wav"
          : "mp3";

  return { blob, filename: `audio.${ext}` };
}

// ─── Transcribe using OpenAI Whisper API ──────────────────
async function transcribeWithWhisper(
  audioBlob: Blob,
  filename: string,
  apiKey: string,
  language?: string,
): Promise<{ text: string; segments: any[] }> {
  const form = new FormData();
  form.append("file", audioBlob, filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json"); // gives us segments + timestamps
  if (language) form.append("language", language);

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper API error: ${err}`);
  }

  const result = await response.json();

  return {
    text: result.text,
    segments: (result.segments ?? []).map((s: any) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    })),
  };
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
    const { openai_api_key, video_url, language } = body;

    if (!openai_api_key?.trim()) {
      return new Response(
        JSON.stringify({ error: "openai_api_key is required" }),
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

    let audioUrl: string;
    let videoTitle = "Unknown";

    // ── 2. Get audio URL ───────────────────────────────
    if (isYouTube(video_url)) {
      const videoId = extractYouTubeId(video_url);
      if (!videoId) {
        return new Response(
          JSON.stringify({
            error: "Could not extract YouTube video ID from URL",
          }),
          {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          },
        );
      }
      console.log(`[transcript] YouTube video ID: ${videoId}`);
      const ytData = await getYouTubeAudioUrl(videoId);
      audioUrl = ytData.url;
      videoTitle = ytData.title;
    } else {
      // Direct URL — could be mp4, mp3, wav, webm etc.
      audioUrl = video_url;
    }

    // ── 3. Fetch the audio ─────────────────────────────
    console.log(`[transcript] Fetching audio...`);
    const { blob, filename } = await fetchAudioBlob(audioUrl);
    console.log(
      `[transcript] Audio fetched: ${(blob.size / 1024 / 1024).toFixed(2)}MB`,
    );

    // ── 4. Transcribe with Whisper ─────────────────────
    console.log(`[transcript] Sending to Whisper...`);
    const { text, segments } = await transcribeWithWhisper(
      blob,
      filename,
      openai_api_key,
      language,
    );

    // ── 5. Return transcript ───────────────────────────
    return new Response(
      JSON.stringify({
        success: true,
        title: videoTitle,
        language: language ?? "auto-detected",
        transcript: text, // full transcript as plain text
        segments, // array of { start, end, text } with timestamps
        word_count: text.split(" ").filter(Boolean).length,
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
