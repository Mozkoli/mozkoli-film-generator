import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 5000);
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(appDirectory, "public");
const MAX_STORY_LENGTH = 1200;
const GENERATION_TIMEOUT_MS = 120_000;
const FILM_PLAN_INSTRUCTIONS = [
  "Create a complete, cinematic film development plan from the user's story idea.",
  "Return only valid JSON with no Markdown fences and exactly these keys:",
  '{"concept":"string","logline":"string","genre":"string","tone":"string","shotList":[{"shot":1,"title":"string","visual":"string","action":"string","dialogue":"string"}],"characterBible":[{"name":"string","role":"string","description":"string","arc":"string"}],"imagePrompts":[{"shot":1,"prompt":"string"}],"motionPrompts":[{"shot":1,"prompt":"string"}],"musicPrompt":"string"}',
  "Requirements: shotList, imagePrompts, and motionPrompts must each contain exactly 7 numbered entries. Make the shots a coherent beginning, middle, and end. Give the characterBible 2 to 4 principal characters. Keep character appearance and locations consistent across image prompts. Write imagePrompts as detailed Bing image-generation prompts with composition, lens, lighting, color, setting, and aspect ratio. Write motionPrompts as Gemini video prompts with subject movement, camera movement, pacing, and duration. Write musicPrompt as one specific Suno AI score prompt with instrumentation, tempo, mood, dynamics, and vocal guidance. Treat cultural and spiritual material respectfully.",
].join("\n\n");

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
        max_tokens: 4096,
        temperature: 0.7,
        ...(provider === "Pollinations"
          ? { response_format: { type: "json_object" } }
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
      throw new ProviderRequestError(
        provider,
        502,
        `${provider} returned an incomplete film plan.`,
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
    plan = JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
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
