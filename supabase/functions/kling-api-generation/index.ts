// ============================================================
//  Supabase Edge Function: kling-video
//  Deploy path: supabase/functions/kling-video/index.ts
//
//  Supports:
//  - Text to Video
//  - Image to Video
//  Uses official Kling API (api.klingai.com) with JWT auth
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KLING_BASE_URL = "https://api.klingai.com";

// ─── Request body ─────────────────────────────────────────
interface KlingRequest {
  access_key: string; // REQUIRED — Kling Access Key
  secret_key: string; // REQUIRED — Kling Secret Key

  // Video params
  prompt: string; // REQUIRED — max 2500 chars
  negative_prompt?: string; // optional — what NOT to generate
  model_name?: // optional — default: "kling-v1-6"
    | "kling-v1"
    | "kling-v1-5"
    | "kling-v1-6"
    | "kling-v2-1"
    | "kling-v2-1-master";
  mode?: "std" | "pro"; // optional — std=faster, pro=higher quality. default: "std"
  duration?: 5 | 10; // optional — seconds. default: 5
  aspect_ratio?: // optional — default: "16:9"
    "16:9" | "9:16" | "1:1";
  cfg_scale?: number; // optional — 0 to 1, how closely to follow prompt. default: 0.5

  // Image to video — optional
  // if provided → image-to-video mode
  // if not provided → text-to-video mode
  image_url?: string; // optional — public URL of reference image
  image_tail_url?: string; // optional — public URL of last frame image

  // Camera control (only for text-to-video, kling-v1-6)
  camera_type?:
    | "simple"
    | "down_back"
    | "forward_up"
    | "right_turn_forward"
    | "left_turn_forward";
  camera_horizontal?: number; // -10 to 10
  camera_vertical?: number; // -10 to 10
  camera_pan?: number; // -10 to 10
  camera_tilt?: number; // -10 to 10
  camera_roll?: number; // -10 to 10
  camera_zoom?: number; // -10 to 10
}

// ─── Generate JWT token for Kling API ────────────────────
// Kling uses HS256 JWT: iss=access_key, signed with secret_key
function generateKlingJWT(accessKey: string, secretKey: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: accessKey,
    exp: now + 1800, // expires in 30 minutes
    nbf: now - 5, // valid 5 seconds before now (clock skew buffer)
  };

  const base64url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  // HMAC-SHA256 signing using Web Crypto API (Deno compatible)
  return signingInput; // placeholder — see async version below
}

// Async JWT generation using Web Crypto (proper HMAC-SHA256)
async function generateJWT(
  accessKey: string,
  secretKey: string,
): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const now = Math.floor(Date.now() / 1000);
  const payload = btoa(
    JSON.stringify({
      iss: accessKey,
      exp: now + 1800,
      nbf: now - 5,
    }),
  )
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${sigB64}`;
}

// ─── Create video task ────────────────────────────────────
async function createVideoTask(
  body: KlingRequest,
  jwt: string,
): Promise<string> {
  const isImageToVideo = !!body.image_url;

  // Build endpoint based on mode
  const endpoint = isImageToVideo
    ? `${KLING_BASE_URL}/v1/videos/image2video`
    : `${KLING_BASE_URL}/v1/videos/text2video`;

  // Build request payload
  const payload: Record<string, any> = {
    model_name: body.model_name ?? "kling-v1-6",
    prompt: body.prompt,
    mode: body.mode ?? "std",
    duration: String(body.duration ?? 5),
    aspect_ratio: body.aspect_ratio ?? "16:9",
    cfg_scale: body.cfg_scale ?? 0.5,
  };

  if (body.negative_prompt) payload.negative_prompt = body.negative_prompt;

  // Image to video params
  if (isImageToVideo) {
    payload.image = body.image_url;
    if (body.image_tail_url) payload.image_tail = body.image_tail_url;
  }

  // Camera control (only text-to-video + kling-v1-6)
  if (!isImageToVideo && body.camera_type) {
    payload.camera_control = {
      type: body.camera_type,
      config: {
        horizontal: body.camera_horizontal ?? 0,
        vertical: body.camera_vertical ?? 0,
        pan: body.camera_pan ?? 0,
        tilt: body.camera_tilt ?? 0,
        roll: body.camera_roll ?? 0,
        zoom: body.camera_zoom ?? 0,
      },
    };
  }

  console.log(
    `[kling] Creating ${isImageToVideo ? "image-to-video" : "text-to-video"} task`,
  );
  console.log(
    `[kling] Model: ${payload.model_name}, Mode: ${payload.mode}, Duration: ${payload.duration}s`,
  );

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kling task creation failed (${res.status}): ${err}`);
  }

  const data = await res.json();

  if (data.code !== 0) {
    throw new Error(`Kling API error: ${data.message ?? JSON.stringify(data)}`);
  }

  const taskId = data.data?.task_id;
  if (!taskId) throw new Error("No task_id returned from Kling API");

  console.log(`[kling] Task created: ${taskId}`);
  return taskId;
}

// ─── Poll until task completes ────────────────────────────
async function pollTask(
  taskId: string,
  jwt: string,
  isImageToVideo: boolean,
  maxWaitMs = 15 * 60 * 1000, // 15 min max
  intervalMs = 10_000, // poll every 10 seconds
): Promise<{ video_url: string; cover_image_url: string; duration: string }> {
  const endpoint = isImageToVideo
    ? `${KLING_BASE_URL}/v1/videos/image2video/${taskId}`
    : `${KLING_BASE_URL}/v1/videos/text2video/${taskId}`;

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (!res.ok) {
      throw new Error(`Kling poll failed (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();

    if (data.code !== 0) {
      throw new Error(`Kling poll error: ${data.message}`);
    }

    const task = data.data;
    const status = task?.task_status;

    console.log(`[kling] Task ${taskId} — status: ${status}`);

    if (status === "succeed") {
      const videos = task?.task_result?.videos ?? [];
      if (!videos.length)
        throw new Error("Task succeeded but no videos returned.");
      return {
        video_url: videos[0].url,
        cover_image_url: videos[0].cover_image_url ?? "",
        duration: videos[0].duration ?? "5",
      };
    }

    if (status === "failed") {
      throw new Error(
        `Kling video generation failed: ${task?.task_status_msg ?? "Unknown error"}`,
      );
    }

    // statuses: submitted, processing — keep polling
  }

  throw new Error("Kling task timed out (15 min limit reached).");
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
    const body: KlingRequest = await req.json();
    const { access_key, secret_key, prompt } = body;

    if (!access_key?.trim())
      return new Response(JSON.stringify({ error: "access_key is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    if (!secret_key?.trim())
      return new Response(JSON.stringify({ error: "secret_key is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    if (!prompt?.trim())
      return new Response(JSON.stringify({ error: "prompt is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    if (prompt.length > 2500)
      return new Response(
        JSON.stringify({ error: "prompt must be under 2500 characters" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    if (body.duration && ![5, 10].includes(body.duration))
      return new Response(
        JSON.stringify({ error: "duration must be 5 or 10" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    if (
      body.cfg_scale !== undefined &&
      (body.cfg_scale < 0 || body.cfg_scale > 1)
    )
      return new Response(
        JSON.stringify({ error: "cfg_scale must be between 0 and 1" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );

    // kling-v2-1-master only supports pro mode
    if (body.model_name === "kling-v2-1-master" && body.mode === "std") {
      return new Response(
        JSON.stringify({ error: "kling-v2-1-master only supports mode: pro" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // ── 2. Generate JWT ────────────────────────────────
    const jwt = await generateJWT(access_key, secret_key);

    // ── 3. Create task ─────────────────────────────────
    const isImageToVideo = !!body.image_url;
    const taskId = await createVideoTask(body, jwt);

    // ── 4. Poll until done ─────────────────────────────
    // JWT expires in 30 min — regenerate if task takes long
    let currentJwt = jwt;
    const jwtRefreshAt = Date.now() + 25 * 60 * 1000; // refresh after 25 min

    const pollWithJwtRefresh = async () => {
      if (Date.now() > jwtRefreshAt) {
        currentJwt = await generateJWT(access_key, secret_key);
        console.log(`[kling] JWT refreshed`);
      }
      return pollTask(taskId, currentJwt, isImageToVideo);
    };

    const result = await pollWithJwtRefresh();

    console.log(`[kling] Done! Video URL: ${result.video_url}`);

    // ── 5. Return result ───────────────────────────────
    return new Response(
      JSON.stringify({
        success: true,
        task_id: taskId,
        mode: isImageToVideo ? "image-to-video" : "text-to-video",
        model: body.model_name ?? "kling-v1-6",
        video_url: result.video_url, // direct MP4 URL — valid for ~24 hours
        cover_image_url: result.cover_image_url, // thumbnail
        duration: result.duration,
        prompt: body.prompt,
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[kling] Error:", err);
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
