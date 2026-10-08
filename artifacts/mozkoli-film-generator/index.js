import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 5000);
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(appDirectory, "public");
const MAX_STORY_LENGTH = 1200;
const GENERATION_TIMEOUT_MS = 120_000;

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

  const prompt = [
    "Create a complete, cinematic film development plan from the story idea below.",
    "Return only valid JSON with no Markdown fences and exactly these keys:",
    '{"concept":"string","logline":"string","genre":"string","tone":"string","shotList":[{"shot":1,"title":"string","visual":"string","action":"string","dialogue":"string"}],"characterBible":[{"name":"string","role":"string","description":"string","arc":"string"}],"imagePrompts":[{"shot":1,"prompt":"string"}],"motionPrompts":[{"shot":1,"prompt":"string"}],"musicPrompt":"string"}',
    "Requirements: shotList, imagePrompts, and motionPrompts must each contain exactly 7 numbered entries. Make the shots a coherent beginning, middle, and end. Give the characterBible 2 to 4 principal characters. Keep character appearance and locations consistent across image prompts. Write imagePrompts as detailed Bing image-generation prompts with composition, lens, lighting, color, setting, and aspect ratio. Write motionPrompts as Gemini video prompts with subject movement, camera movement, pacing, and duration. Write musicPrompt as one specific Suno AI score prompt with instrumentation, tempo, mood, dynamics, and vocal guidance. Treat cultural and spiritual material respectfully.",
    `Story idea: ${story}`,
  ].join("\n\n");

  const pollinationsUrl = new URL("https://text.pollinations.ai/");
  pollinationsUrl.pathname = `/${encodeURIComponent(prompt)}`;
  pollinationsUrl.searchParams.set("model", "openai-fast");

  if (pollinationsUrl.href.length > 14_000) {
    return response.status(400).json({
      error: "This story idea is too long to send to Pollinations. Please shorten it.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GENERATION_TIMEOUT_MS,
  );

  try {
    const upstream = await fetch(pollinationsUrl, {
      headers: { Accept: "text/plain" },
      signal: controller.signal,
    });
    const generatedText = (await upstream.text()).trim();

    if (!upstream.ok) {
      const statusMessage =
        upstream.status === 402
          ? "Pollinations is not accepting keyless requests right now."
          : upstream.status === 429
            ? "Pollinations is busy. Please wait a moment and try again."
            : `Pollinations is temporarily unavailable (HTTP ${upstream.status}).`;
      return response.status(502).json({ error: statusMessage });
    }

    const filmPlan = parseFilmPlan(generatedText);
    if (!filmPlan) {
      return response.status(502).json({
        error:
          "Pollinations returned an incomplete film plan. Please try generating it again.",
      });
    }

    return response.json({ filmPlan });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return response.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "Film generation took too long. Please try again."
        : "Could not reach Pollinations. Check your connection and try again.",
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
