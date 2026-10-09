import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 5000);
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(appDirectory, "public");
const MAX_STORY_LENGTH = 1200;
const GENERATION_TIMEOUT_MS = 120_000;
const MAX_VIDEO_PROMPT_LENGTH = 2500;
const MAX_VIDEO_RESPONSE_BYTES = 100 * 1024 * 1024;
const VIDEO_GENERATION_TIMEOUT_MS = 300_000;
const VIDEO_MODELS = new Set([
  "google/veo-3.1-fast",
  "google/gemini-omni-1.1-flash",
  "bytedance/seedance-2.0",
  "bytedance/seedance-1-pro-fast",
]);
const FILM_PLAN_INSTRUCTIONS = [
  "Create a complete, cinematic film development plan from the user's story idea.",
  "Return only valid JSON with no Markdown fences and exactly these keys:",
  '{"concept":"string","logline":"string","genre":"string","tone":"string","shotList":[{"shot":1,"title":"string","visual":"string","action":"string","dialogue":"string"}],"characterBible":[{"name":"string","role":"string","description":"string","arc":"string"}],"imagePrompts":[{"shot":1,"prompt":"string"}],"motionPrompts":[{"shot":1,"prompt":"string"}],"musicPrompt":"string"}',
  "Requirements: shotList, imagePrompts, and motionPrompts must each contain exactly 7 numbered entries. Make the shots a coherent beginning, middle, and end. Give the characterBible 2 to 4 principal characters. Keep character appearance and locations consistent across image prompts. Write imagePrompts as detailed Bing image-generation prompts with composition, lens, lighting, color, setting, and aspect ratio. Write motionPrompts as Gemini video prompts with subject movement, camera movement, pacing, and duration. Write musicPrompt as one specific Suno AI score prompt with instrumentation, tempo, mood, dynamics, and vocal guidance. Treat cultural and spiritual material respectfully.",
].join("\n\n");
const PLAN_STRING = { type: "string" };
const PLAN_SHOT_SCHEMA = {
  type: "object",
  properties: {
    shot: { type: "integer" },
    title: PLAN_STRING,
    visual: PLAN_STRING,
    action: PLAN_STRING,
    dialogue: PLAN_STRING,
  },
  required: ["shot", "title", "visual", "action", "dialogue"],
  additionalProperties: false,
};
const PLAN_PROMPT_SCHEMA = {
  type: "object",
  properties: {
    shot: { type: "integer" },
    prompt: PLAN_STRING,
  },
  required: ["shot", "prompt"],
  additionalProperties: false,
};
const FILM_PLAN_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "film_plan",
    strict: true,
    schema: {
      type: "object",
      properties: {
        concept: PLAN_STRING,
        logline: PLAN_STRING,
        genre: PLAN_STRING,
        tone: PLAN_STRING,
        shotList: { type: "array", items: PLAN_SHOT_SCHEMA },
        characterBible: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: PLAN_STRING,
              role: PLAN_STRING,
              description: PLAN_STRING,
              arc: PLAN_STRING,
            },
            required: ["name", "role", "description", "arc"],
            additionalProperties: false,
          },
        },
        imagePrompts: { type: "array", items: PLAN_PROMPT_SCHEMA },
        motionPrompts: { type: "array", items: PLAN_PROMPT_SCHEMA },
        musicPrompt: PLAN_STRING,
      },
      required: [
        "concept",
        "logline",
        "genre",
        "tone",
        "shotList",
        "characterBible",
        "imagePrompts",
        "motionPrompts",
        "musicPrompt",
      ],
      additionalProperties: false,
    },
  },
};

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.get("/healthz", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/generate", async (request, response) => {
  const story =
    typeof request.body?.story === "string" ? request.body.story.trim() : "";

  if (!story) {
    return response.status(400).json({ error: "Enter a story idea to begin." });
  }

  if (story.length > MAX_STORY_LENGTH) {
    return response.status(400).json({
      error: `Keep your story idea under ${MAX_STORY_LENGTH} characters.`,
    });
  }

  const pollinationsKey = process.env.POLLINATIONS_API_KEY?.trim();
  const huggingFaceToken = process.env.HF_TOKEN?.trim();
  const messages = [
    { role: "system", content: FILM_PLAN_INSTRUCTIONS },
    { role: "user", content: `Story idea: ${story}` },
  ];
  const failures = [];

  if (!pollinationsKey && !huggingFaceToken) {
    return response.status(503).json({
      error:
        "Add POLLINATIONS_API_KEY in Replit Secrets to generate plans. Add HF_TOKEN there to enable the Hugging Face fallback.",
    });
  }

  if (pollinationsKey) {
    try {
      const filmPlan = await requestFilmPlan({
        provider: "Pollinations",
        url: "https://gen.pollinations.ai/v1/chat/completions",
        token: pollinationsKey,
        model: "openai/gpt-5.4-nano",
        messages,
      });
      return response.json({ filmPlan, provider: "Pollinations" });
    } catch (error) {
      failures.push(getSafeProviderError("Pollinations", error));
    }
  }

  if (huggingFaceToken) {
    try {
      const filmPlan = await requestFilmPlan({
        provider: "Hugging Face",
        url: "https://router.huggingface.co/v1/chat/completions",
        token: huggingFaceToken,
        model: "Qwen/Qwen3.8-27B:cheapest",
        messages,
      });
      return response.json({ filmPlan, provider: "Hugging Face" });
    } catch (error) {
      failures.push(getSafeProviderError("Hugging Face", error));
    }
  }

  const fallbackHint = huggingFaceToken
    ? ""
    : " Add HF_TOKEN in Replit Secrets to enable the Hugging Face fallback.";
  return response.status(502).json({
    error: `${failures.join(" ")}${fallbackHint}`,
  });
});

app.post("/generate-video", async (request, response) => {
  const prompt =
    typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
  const model =
    typeof request.body?.model === "string"
      ? request.body.model.trim()
      : "google/veo-3.1-fast";
  const pollinationsKey = process.env.POLLINATIONS_API_KEY?.trim();

  if (!pollinationsKey) {
    return response.status(503).json({
      error: "Add POLLINATIONS_API_KEY in Replit Secrets to generate video clips.",
    });
  }

  if (!prompt) {
    return response.status(400).json({ error: "A motion prompt is required." });
  }

  if (prompt.length > MAX_VIDEO_PROMPT_LENGTH) {
    return response.status(400).json({
      error: `Keep each motion prompt under ${MAX_VIDEO_PROMPT_LENGTH} characters.`,
    });
  }

  if (!VIDEO_MODELS.has(model)) {
    return response.status(400).json({ error: "Choose a supported video model." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    VIDEO_GENERATION_TIMEOUT_MS,
  );

  try {
    const videoUrl = new URL(
      `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}`,
    );
    videoUrl.searchParams.set("model", model);
    const upstream = await fetch(videoUrl, {
      method: "GET",
      headers: {
        Accept: "video/mp4",
        Authorization: `Bearer ${pollinationsKey}`,
      },
      signal: controller.signal,
    });

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      return response
        .status(upstream.status)
        .json({ error: providerStatusMessage("Pollinations video", upstream.status) });
    }

    const contentType = (upstream.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType !== "video/mp4" && contentType !== "application/octet-stream") {
      await upstream.body?.cancel().catch(() => {});
      return response.status(502).json({
        error: "Pollinations did not return a playable MP4. Try another video model.",
      });
    }

    const videoBuffer = await readVideoBuffer(
      upstream,
      MAX_VIDEO_RESPONSE_BYTES,
    );
    const creditHeaders = getPollinationsCreditHeaders(upstream.headers);

    response.set({
      "Cache-Control": "no-store",
      "Content-Disposition": 'inline; filename="mozkoli-film-clip.mp4"',
      "X-Content-Type-Options": "nosniff",
    });
    if (Object.keys(creditHeaders).length > 0) {
      response.set("X-Mozkoli-Credits", JSON.stringify(creditHeaders));
    }
    return response.status(200).type("video/mp4").send(videoBuffer);
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return response.status(error.status).json({ error: error.userMessage });
    }
    if (error instanceof Error && error.name === "AbortError") {
      return response.status(504).json({
        error: "Video generation timed out. Try a faster model or generate one clip again.",
      });
    }
    return response.status(502).json({
      error: "Pollinations could not complete this video. Please try again.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use(
  express.static(publicDirectory, {
    index: "index.html",
    maxAge: 0,
  }),
);

async function requestFilmPlan({ provider, url, token, model, messages }) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GENERATION_TIMEOUT_MS,
  );

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 7000,
        temperature: 0.7,
        ...(provider === "Pollinations"
          ? { response_format: FILM_PLAN_RESPONSE_FORMAT }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      throw new ProviderRequestError(
        provider,
        upstream.status,
        providerStatusMessage(provider, upstream.status),
      );
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new ProviderRequestError(
        provider,
        502,
        `${provider} returned an unreadable response.`,
      );
    }

    const content = getMessageText(payload?.choices?.[0]?.message?.content);
    const filmPlan = content ? parseFilmPlan(content) : null;
    if (!filmPlan) {
      console.error(
        `[${provider}] Invalid film plan response`,
        JSON.stringify(summarizeCompletion(payload, content)),
      );
      throw new ProviderRequestError(
        provider,
        502,
        `${provider} returned a film plan that did not pass validation.`,
      );
    }
    return filmPlan;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderRequestError(
        provider,
        504,
        `${provider} generation timed out.`,
      );
    }
    throw new ProviderRequestError(
      provider,
      502,
      `Could not reach ${provider}.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readVideoBuffer(upstream, maxBytes) {
  if (!upstream.body) {
    throw new ProviderRequestError(
      "Pollinations video",
      502,
      "Pollinations returned an empty video response.",
    );
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of upstream.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new ProviderRequestError(
        "Pollinations video",
        413,
        "The generated clip exceeded the 100 MB app limit.",
      );
    }
    chunks.push(buffer);
  }

  if (totalBytes === 0) {
    throw new ProviderRequestError(
      "Pollinations video",
      502,
      "Pollinations returned an empty video response.",
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

function getPollinationsCreditHeaders(headers) {
  const creditHeaders = {};
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    const isCreditHeader =
      /^x-(?:pollinations-)?pollen(?:-[a-z0-9-]+)?$/.test(name) ||
      /^x-(?:pollinations-)?credits?(?:-[a-z0-9-]+)?$/.test(name) ||
      /^x-pollinations-(?:balance|remaining|cost|spent|used)(?:-[a-z0-9-]+)?$/.test(
        name,
      );
    const safeValue = value.trim();
    if (isCreditHeader && safeValue.length > 0 && safeValue.length <= 100) {
      creditHeaders[name] = safeValue;
    }
  });
  return creditHeaders;
}

function providerStatusMessage(provider, status) {
  if (status === 401) {
    return `${provider} rejected its token. Check the secret saved in Replit.`;
  }
  if (status === 402) {
    return `${provider} reports that the account has no available credits.`;
  }
  if (status === 403) {
    return `${provider} denied access for this token. Check its permissions.`;
  }
  if (status === 429) {
    return `${provider} is rate-limited. Please try again shortly.`;
  }
  if (status >= 500) {
    return `${provider} is temporarily unavailable (HTTP ${status}).`;
  }
  return `${provider} request failed (HTTP ${status}).`;
}

function getSafeProviderError(provider, error) {
  if (error instanceof ProviderRequestError) return error.userMessage;
  return `${provider} could not complete the request.`;
}

function getMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function summarizeCompletion(payload, content) {
  const message = payload?.choices?.[0]?.message;
  let parsed;
  try {
    const trimmed = content.trim();
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
  } catch {
    // The summary only reports structure; never log the generated text itself.
  }
  const plan = parsed?.filmPlan ?? parsed;
  return {
    finishReason: payload?.choices?.[0]?.finish_reason ?? null,
    messageFields: message && typeof message === "object" ? Object.keys(message) : [],
    contentLength: content.length,
    planFields: plan && typeof plan === "object" ? Object.keys(plan) : [],
    counts: {
      shots: Array.isArray(plan?.shotList) ? plan.shotList.length : null,
      characters: Array.isArray(plan?.characterBible)
        ? plan.characterBible.length
        : null,
      imagePrompts: Array.isArray(plan?.imagePrompts)
        ? plan.imagePrompts.length
        : null,
      motionPrompts: Array.isArray(plan?.motionPrompts)
        ? plan.motionPrompts.length
        : null,
    },
  };
}

class ProviderRequestError extends Error {
  constructor(provider, status, userMessage) {
    super(`${provider} request failed`);
    this.provider = provider;
    this.status = status;
    this.userMessage = userMessage;
  }
}

function parseFilmPlan(text) {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  let plan;
  try {
    const parsed = JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
    plan = parsed?.filmPlan ?? parsed;
  } catch {
    return null;
  }

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;

  if (
    !isText(plan.concept) ||
    !isText(plan.logline) ||
    !isText(plan.genre) ||
    !isText(plan.tone) ||
    !isText(plan.musicPrompt) ||
    !Array.isArray(plan.characterBible) ||
    plan.characterBible.length === 0 ||
    !plan.characterBible.every(
      (character) =>
        isText(character.name) &&
        isText(character.role) &&
        isText(character.description) &&
        isText(character.arc),
    ) ||
    !hasSevenEntries(plan.shotList, ["title", "visual", "action", "dialogue"]) ||
    !hasSevenEntries(plan.imagePrompts, ["prompt"]) ||
    !hasSevenEntries(plan.motionPrompts, ["prompt"])
  ) {
    return null;
  }

  return plan;
}

function hasSevenEntries(entries, textFields) {
  return (
    Array.isArray(entries) &&
    entries.length === 7 &&
    entries.every(
      (entry, index) =>
        entry.shot === index + 1 && textFields.every((field) => isText(entry[field])),
    )
  );
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

app.listen(port, "0.0.0.0", () => {
  // The PORT is supplied by the artifact workflow.
});
