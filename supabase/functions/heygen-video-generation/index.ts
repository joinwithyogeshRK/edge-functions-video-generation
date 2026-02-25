import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Fallback hardcoded IDs (used only if API fetch fails) ───
// Replace these with your preferred avatar/voice from HeyGen's catalog
const FALLBACK_AVATAR_ID = "Angela-inTshirt-20220820";
const FALLBACK_VOICE_ID = "1bd001e7e50f421d891986aad5158bc8";

// ─── Request shape ────────────────────────────────────────────
interface GenerateRequest {
  heygen_api_key: string; // REQUIRED
  script: string; // REQUIRED
  avatar_id?: string; // optional — auto-fetched if omitted
  voice_id?: string; // optional — auto-fetched if omitted
  avatar_style?: "normal" | "circle" | "closeUp"; // default: "normal"
  width?: number; // default: 1280
  height?: number; // default: 720
  background_color?: string; // default: "#ffffff"
  title?: string; // default: "Generated Video"
  speed?: number; // 0.5–2.0, default: 1.0
}

// ─── Auto-fetch first available avatar ID from HeyGen ─────────
async function fetchFirstAvatarId(apiKey: string): Promise<string> {
  try {
    const res = await fetch("https://api.heygen.com/v2/avatars", {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) throw new Error("Avatar list fetch failed");
    const json = await res.json();
    const avatars = json?.data?.avatars ?? [];
    if (avatars.length === 0) throw new Error("No avatars found");
    const id = avatars[0]?.avatar_id;
    console.log(`[heygen-video] Auto-selected avatar_id: ${id}`);
    return id;
  } catch (e) {
    console.warn(
      `[heygen-video] Could not fetch avatar list (${e}), using fallback.`,
    );
    return FALLBACK_AVATAR_ID;
  }
}

// ─── Auto-fetch first available voice ID from HeyGen ──────────
async function fetchFirstVoiceId(apiKey: string): Promise<string> {
  try {
    const res = await fetch("https://api.heygen.com/v2/voices", {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) throw new Error("Voice list fetch failed");
    const json = await res.json();
    const voices = json?.data?.voices ?? [];
    if (voices.length === 0) throw new Error("No voices found");
    // prefer an English voice if available
    const english = voices.find(
      (v: any) => v.language === "English" || v.locale?.startsWith("en"),
    );
    const id = (english ?? voices[0])?.voice_id;
    console.log(`[heygen-video] Auto-selected voice_id: ${id}`);
    return id;
  } catch (e) {
    console.warn(
      `[heygen-video] Could not fetch voice list (${e}), using fallback.`,
    );
    return FALLBACK_VOICE_ID;
  }
}

// ─── Poll until completed or failed ───────────────────────────
async function pollUntilComplete(
  videoId: string,
  apiKey: string,
  maxWaitMs = 15 * 60 * 1000,
  intervalMs = 10_000,
): Promise<{
  video_id: string;
  status: string;
  video_url?: string;
  error?: string;
}> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
      { headers: { Accept: "application/json", "X-Api-Key": apiKey } },
    );

    if (!res.ok) throw new Error(`Poll failed: ${await res.text()}`);

    const json = await res.json();
    const job = json.data;
    console.log(`[heygen-video] ${videoId} — ${job.status}`);

    if (job.status === "completed" || job.status === "failed") return job;
  }

  throw new Error("Timed out waiting for HeyGen video (15 min limit reached).");
}

// ─── Main handler ──────────────────────────────────────────────
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
    // ── 1. Parse & validate ──────────────────────────────
    const body: GenerateRequest = await req.json();
    const {
      heygen_api_key,
      script,
      avatar_style = "normal",
      width = 1280,
      height = 720,
      background_color = "#ffffff",
      title = "Generated Video",
      speed = 1.0,
    } = body;

    if (!heygen_api_key?.trim()) {
      return new Response(
        JSON.stringify({ error: "heygen_api_key is required" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }
    if (!script?.trim()) {
      return new Response(JSON.stringify({ error: "script is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (speed < 0.5 || speed > 2.0) {
      return new Response(
        JSON.stringify({ error: "speed must be between 0.5 and 2.0" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // ── 2. Resolve avatar_id and voice_id ────────────────
    // Priority: user-provided → fetched from HeyGen API → hardcoded fallback
    const [avatar_id, voice_id] = await Promise.all([
      body.avatar_id?.trim() || fetchFirstAvatarId(heygen_api_key),
      body.voice_id?.trim() || fetchFirstVoiceId(heygen_api_key),
    ]);

    console.log(
      `[heygen-video] Using avatar_id=${avatar_id} voice_id=${voice_id}`,
    );

    // ── 3. Create HeyGen video job ───────────────────────
    const payload = {
      title,
      video_inputs: [
        {
          character: {
            type: "avatar",
            avatar_id,
            avatar_style,
          },
          voice: {
            type: "text",
            input_text: script,
            voice_id,
            speed,
          },
          background: {
            type: "color",
            value: background_color,
          },
        },
      ],
      dimension: { width, height },
    };

    const createRes = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: {
        "X-Api-Key": heygen_api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!createRes.ok) {
      return new Response(
        JSON.stringify({
          error: "HeyGen video creation failed",
          details: await createRes.text(),
        }),
        {
          status: createRes.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    const createJson = await createRes.json();
    const videoId: string = createJson?.data?.video_id;

    if (!videoId) {
      return new Response(
        JSON.stringify({
          error: "HeyGen did not return a video_id",
          raw: createJson,
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    console.log(`[heygen-video] Job created: ${videoId}`);

    // ── 4. Poll until done ───────────────────────────────
    const completed = await pollUntilComplete(videoId, heygen_api_key);

    if (completed.status === "failed") {
      return new Response(
        JSON.stringify({
          error: "HeyGen video generation failed",
          video_id: completed.video_id,
          reason: completed.error ?? "HeyGen returned a failure status.",
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    if (!completed.video_url) {
      throw new Error("HeyGen returned completed status but no video_url.");
    }

    // ── 5. Download the MP4 from HeyGen ──────────────────
    const videoRes = await fetch(completed.video_url);
    if (!videoRes.ok) {
      throw new Error(
        `Failed to download video from HeyGen: ${await videoRes.text()}`,
      );
    }
    const videoBuffer = await videoRes.arrayBuffer();

    // ── 6. Upload to Supabase Storage ────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const fileName = `${videoId}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from("heygen-videos")
      .upload(fileName, videoBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
    }

    // ── 7. Return permanent public URL ───────────────────
    const { data: urlData } = supabase.storage
      .from("heygen-videos")
      .getPublicUrl(fileName);

    return new Response(
      JSON.stringify({
        success: true,
        video_id: videoId,
        avatar_id,
        voice_id,
        dimension: { width, height },
        video_url: urlData.publicUrl,
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[heygen-video] Error:", err);
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
