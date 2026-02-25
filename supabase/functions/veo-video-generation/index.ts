import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ─── Request shape ────────────────────────────────────────────
interface GenerateRequest {
  gemini_api_key: string; // REQUIRED
  prompt: string; // REQUIRED
  model?: string; // default: "veo-3.1-generate-preview"
  aspect_ratio?: "16:9" | "9:16"; // default: "16:9"
  resolution?: "720p" | "1080p" | "4k"; // default: "720p"
  duration_seconds?: "4" | "6" | "8"; // default: "8"
  negative_prompt?: string; // optional: what NOT to include
  image_url?: string; // optional: public image URL → used as first frame
  person_generation?: "allow_all" | "allow_adult" | "dont_allow"; // default: "allow_all"
}

// ─── Poll until done ──────────────────────────────────────────
async function pollUntilComplete(
  operationName: string,
  apiKey: string,
  maxWaitMs = 10 * 60 * 1000, // 10 min (Veo max latency is ~6 min)
  intervalMs = 10_000,
): Promise<any> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(`${BASE_URL}/${operationName}`, {
      headers: { "x-goog-api-key": apiKey },
    });

    if (!res.ok) throw new Error(`Poll failed: ${await res.text()}`);

    const operation = await res.json();
    console.log(
      `[veo-video] ${operationName} — done: ${operation.done ?? false}`,
    );

    if (operation.done) return operation;
  }

  throw new Error("Timed out waiting for Veo video (10 min limit reached).");
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
      gemini_api_key,
      prompt,
      model = "veo-3.1-generate-preview",
      aspect_ratio = "16:9",
      resolution = "720p",
      duration_seconds = "8",
      negative_prompt,
      image_url,
      person_generation = "allow_all",
    } = body;

    if (!gemini_api_key?.trim()) {
      return new Response(
        JSON.stringify({ error: "gemini_api_key is required" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }
    if (!prompt?.trim()) {
      return new Response(JSON.stringify({ error: "prompt is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 1080p and 4k only support 8s
    if (
      (resolution === "1080p" || resolution === "4k") &&
      duration_seconds !== "8"
    ) {
      return new Response(
        JSON.stringify({
          error: "1080p and 4k resolution only support duration_seconds = '8'",
        }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // ── 2. Build request payload ─────────────────────────
    const instance: any = { prompt };

    // If user provides an image URL, fetch it and pass as first frame (base64)
    if (image_url) {
      const imgRes = await fetch(image_url);
      if (!imgRes.ok) {
        return new Response(
          JSON.stringify({ error: "Could not fetch image_url" }),
          {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          },
        );
      }
      const imgBuffer = await imgRes.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));
      const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
      instance.image = { inlineData: { mimeType, data: base64 } };
    }

    const parameters: any = {
      aspectRatio: aspect_ratio,
      resolution,
      durationSeconds: duration_seconds,
      personGeneration: person_generation,
      numberOfVideos: 1,
    };

    if (negative_prompt?.trim()) {
      parameters.negativePrompt = negative_prompt;
    }

    const payload = { instances: [instance], parameters };

    // ── 3. Submit video generation job ──────────────────
    const createRes = await fetch(
      `${BASE_URL}/models/${model}:predictLongRunning`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": gemini_api_key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!createRes.ok) {
      return new Response(
        JSON.stringify({
          error: "Veo job creation failed",
          details: await createRes.text(),
        }),
        {
          status: createRes.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    const createJson = await createRes.json();
    const operationName: string = createJson?.name;

    if (!operationName) {
      return new Response(
        JSON.stringify({
          error: "Veo did not return an operation name",
          raw: createJson,
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    console.log(`[veo-video] Job created: ${operationName}`);

    // ── 4. Poll until done ───────────────────────────────
    const completed = await pollUntilComplete(operationName, gemini_api_key);

    // Check for errors in the completed operation
    if (completed.error) {
      return new Response(
        JSON.stringify({
          error: "Veo video generation failed",
          reason: completed.error?.message ?? "Unknown error from Veo",
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // Extract video URI from response
    const videoUri =
      completed?.response?.generateVideoResponse?.generatedSamples?.[0]?.video
        ?.uri;

    if (!videoUri) {
      throw new Error("Veo returned done=true but no video URI found.");
    }

    // ── 5. Download the MP4 from Google ─────────────────
    const videoRes = await fetch(videoUri, {
      headers: { "x-goog-api-key": gemini_api_key },
    });

    if (!videoRes.ok) {
      throw new Error(
        `Failed to download video from Veo: ${await videoRes.text()}`,
      );
    }

    const videoBuffer = await videoRes.arrayBuffer();

    // ── 6. Upload to Supabase Storage ────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Use operation name as unique filename (strip slashes)
    const fileName = `${operationName.replace(/\//g, "_")}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from("veo-videos") // Supabase → Storage → New Bucket → "veo-videos" → Public
      .upload(fileName, videoBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
    }

    // ── 7. Return permanent public URL ───────────────────
    const { data: urlData } = supabase.storage
      .from("veo-videos")
      .getPublicUrl(fileName);

    return new Response(
      JSON.stringify({
        success: true,
        operation_name: operationName,
        model,
        aspect_ratio,
        resolution,
        duration_seconds,
        video_url: urlData.publicUrl, // permanent — no auth, no expiry
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[veo-video] Error:", err);
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

// ═══════════════════════════════════════════════════════════════
//  SETUP NOTES
// ═══════════════════════════════════════════════════════════════
//
//  1. SUPABASE BUCKET
//     Supabase Dashboard → Storage → New Bucket
//     Name: veo-videos   |   Visibility: Public
//
//  2. DEPLOY
//     supabase functions deploy veo-video
//
//  3. MINIMAL REQUEST (text to video)
//     curl -X POST https://<project>.supabase.co/functions/v1/veo-video \
//       -H "Content-Type: application/json" \
//       -d '{
//         "gemini_api_key": "your-gemini-api-key",
//         "prompt": "A cinematic shot of a majestic lion in the savannah."
//       }'
//
//  4. FULL REQUEST
//     curl -X POST https://<project>.supabase.co/functions/v1/veo-video \
//       -H "Content-Type: application/json" \
//       -d '{
//         "gemini_api_key": "your-gemini-api-key",
//         "prompt": "A drone flying over the Grand Canyon at sunset.",
//         "model": "veo-3.1-generate-preview",
//         "aspect_ratio": "16:9",
//         "resolution": "1080p",
//         "duration_seconds": "8",
//         "negative_prompt": "cartoon, low quality, blurry",
//         "image_url": "https://example.com/my-first-frame.jpg"
//       }'
//
//  5. RESPONSE
//     {
//       "success": true,
//       "operation_name": "operations/abc123",
//       "model": "veo-3.1-generate-preview",
//       "aspect_ratio": "16:9",
//       "resolution": "1080p",
//       "duration_seconds": "8",
//       "video_url": "https://xyz.supabase.co/storage/v1/object/public/veo-videos/abc123.mp4"
//     }
//
//  6. AVAILABLE MODELS
//     "veo-3.1-generate-preview"       → best quality, audio, portrait support
//     "veo-3.1-fast-generate-preview"  → faster, cheaper
//     "veo-2.0-generate-001"           → stable, silent only
