import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface GenerateRequest {
  openai_api_key: string;           // REQUIRED
  prompt: string;                   // REQUIRED
  model?: "sora-2" | "sora-2-pro"; // default: "sora-2"
  size?: string;                    // default: "1280x720"
  seconds?: number;                 // default: 5 (range: 5–20)
  input_reference_url?: string;     // optional: public image URL as first frame
}

interface SoraJob {
  id: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  model: string;
  progress: number;
  seconds: string;
  size: string;
  error?: { message: string };
}

// ─── Poll until completed or failed ──────────────────────
async function pollUntilComplete(
  jobId: string,
  apiKey: string,
  maxWaitMs = 12 * 60 * 1000,
  intervalMs = 10_000
): Promise<SoraJob> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(`https://api.openai.com/v1/videos/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) throw new Error(`Poll failed: ${await res.text()}`);

    const job: SoraJob = await res.json();
    console.log(`[sora-video] ${jobId} — ${job.status} ${job.progress ?? 0}%`);

    if (job.status === "completed" || job.status === "failed") return job;
  }

  throw new Error("Timed out waiting for video (12 min limit reached).");
}

// ─── Main handler ─────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Only POST is allowed" }),
      { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  try {
    // ── 1. Parse & validate ────────────────────────────
    const body: GenerateRequest = await req.json();
    const {
      openai_api_key,
      prompt,
      model = "sora-2",
      size = "1280x720",
      seconds = 5,
      input_reference_url,
    } = body;

    if (!openai_api_key?.trim()) {
      return new Response(
        JSON.stringify({ error: "openai_api_key is required" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
    if (!prompt?.trim()) {
      return new Response(
        JSON.stringify({ error: "prompt is required" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
    if (seconds < 5 || seconds > 20) {
      return new Response(
        JSON.stringify({ error: "seconds must be between 5 and 20" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // ── 2. Build form and create Sora job ──────────────
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("seconds", String(seconds));

    if (input_reference_url) {
      const imgRes = await fetch(input_reference_url);
      if (!imgRes.ok) {
        return new Response(
          JSON.stringify({ error: `Could not fetch input_reference_url` }),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
      form.append("input_reference", await imgRes.blob(), "reference.jpg");
    }

    const createRes = await fetch("https://api.openai.com/v1/videos", {
      method: "POST",
      headers: { Authorization: `Bearer ${openai_api_key}` },
      body: form,
    });

    if (!createRes.ok) {
      return new Response(
        JSON.stringify({ error: "Sora job creation failed", details: await createRes.text() }),
        { status: createRes.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const job: SoraJob = await createRes.json();
    console.log(`[sora-video] Job created: ${job.id}`);

    // ── 3. Poll until done ─────────────────────────────
    const completed = await pollUntilComplete(job.id, openai_api_key);

    if (completed.status === "failed") {
      return new Response(
        JSON.stringify({
          error: "Video generation failed",
          job_id: completed.id,
          reason: completed.error?.message ?? "Sora returned a failure status.",
        }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // ── 4. Download MP4 from OpenAI ────────────────────
    const videoRes = await fetch(
      `https://api.openai.com/v1/videos/${completed.id}/content?variant=video`,
      { headers: { Authorization: `Bearer ${openai_api_key}` } }
    );

    if (!videoRes.ok) {
      throw new Error(`Failed to download video from OpenAI: ${await videoRes.text()}`);
    }

    const videoBuffer = await videoRes.arrayBuffer();

    // ── 5. Upload to Supabase Storage ──────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const fileName = `${completed.id}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from("sora-videos")            // your bucket name
      .upload(fileName, videoBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
    }

    // ── 6. Get public URL and return to user ───────────
    const { data: urlData } = supabase.storage
      .from("sora-videos")
      .getPublicUrl(fileName);

    return new Response(
      JSON.stringify({
        success: true,
        job_id: completed.id,
        model: completed.model,
        size: completed.size,
        seconds: completed.seconds,
        video_url: urlData.publicUrl,  // permanent public URL — no auth needed
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[sora-video] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});




// ### What changed
// The old base64 approach is gone. Now after the video is done, we download it from OpenAI and upload it straight to **Supabase Storage**. User gets back a clean permanent URL like:
// https://xyz.supabase.co/storage/v1/object/public/sora-videos/video_abc123.mp4
// User can paste this in a browser, put it in a <video> tag, or just click it — it downloads directly. No API key needed, no expiry.
// One thing you need to do in Supabase
// Go to Supabase Dashboard → Storage → New Bucket and create a bucket named sora-videos and set it to Public. That's it.
