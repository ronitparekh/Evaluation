const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

function getApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return key;
}

function buildAdjustPrompt({ question, studentAnswer, referenceText, rubricScore }) {
  return `You are an experienced UPSC GS examiner ASSISTING an automated scoring system.

IMPORTANT CONTEXT:
- Student answer is OCR-extracted handwritten text.
- Contains spelling errors, broken words, missing structure.
- DO NOT penalize language, handwriting, spelling or OCR artifacts.
- Normalize incorrect words mentally to closest UPSC terms.

YOUR ROLE:
- The system has already given a BASE rubric score.
- You may ONLY ENHANCE the score if deserved.
- NEVER reduce marks.
- If unsure, return score_adjustment = 0.

LAYOUT EVALUATION:
- Judge whether the answer follows UPSC-friendly structure: intro, body with sub-points, conclusion.
- Reward relevant headings, numbering, diagram placement, logical flow, use of space.
- Deduct for missing sections or chaotic order.
- Provide a layout_score from 0-10 reflecting these cues.

VISUAL EVALUATION:
- Assess any diagrams, sketches, tables, or flow structures embedded or referenced in the answer.
- Consider whether they are relevant, well-labeled, and reinforce the argument.
- Provide a visual_score from 0-10 representing that judgment.
- Diagrams images sometimes may include full page image so focus on the visual or diagrams inside the page rather than the entire page image

SCORING RULES:
- score_adjustment: +0 to +2 only.

OUTPUT FORMAT (STRICT JSON ONLY):
{
  "score_adjustment": number,
  "layout_score": number between 0 and 10,
  "visual_score": number between 0 and 10,
  "confidence": number between 0 and 1
}

QUESTION:
${question || "(not provided)"}

REFERENCE MATERIAL:
${referenceText}

STUDENT ANSWER (OCR TEXT):
${studentAnswer}

CURRENT RUBRIC SCORE (0-10):
${rubricScore}`;
}

function buildScorePrompt({ question, studentAnswer }) {
  return `You are an experienced UPSC GS examiner.

IMPORTANT CONTEXT:
- The answer is OCR-extracted from a handwritten script.
- Text contains spelling errors, broken words, missing punctuation and lost structure.
- DO NOT penalize spelling, grammar, handwriting or OCR noise.
- Mentally normalize words to closest valid UPSC terms.

EVALUATION:
- Give an overall score (0-10) for relevance + content quality.
- Separately, judge layout/structure as per UPSC presentation norms and give layout_score (0-10).
- Also evaluate any diagrams/visuals referenced and return a visual_score (0-10) assessing their relevance.

OUTPUT FORMAT (STRICT JSON ONLY):
{
  "score": number,
  "layout_score": number between 0 and 10,
  "visual_score": number between 0 and 10,
  "confidence": number between 0 and 1
}

QUESTION:
${question || "(not provided)"}

STUDENT ANSWER (OCR TEXT):
${studentAnswer}`;
}

function buildNormalizationPrompt({ studentAnswer }) {
  return "You are cleaning OCR-extracted handwritten UPSC answers. Do NOT change the meaning of any sentence. Do not add or remove ideas. Only fix spelling, broken words, and sentence continuity. Restore intended UPSC terms where obvious. If unsure, keep original wording. Output only the cleaned answer.\n\nRAW OCR ANSWER:\n" + studentAnswer;
}

function safeParseJson(text) {
  if (!text) {
    return null;
  }

  const cleaned = text
    .replace(/```json\s*/i, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const jsonSlice =
    firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
      ? cleaned.slice(firstBrace, lastBrace + 1)
      : cleaned;

  try {
    return JSON.parse(jsonSlice);
  } catch {
    return null;
  }
}

function tokenJaccard(a, b) {
  const toTokens = (value) =>
    new Set(
      (value || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
    );

  const setA = toTokens(a);
  const setB = toTokens(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function callOpenai({ model, prompt, jsonMode }) {
  const apiKey = getApiKey();
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Return only JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      response_format: jsonMode ? { type: "json_object" } : undefined
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return content;
}

export async function normalizeAnswerWithOpenAI({
  studentAnswer,
  model = DEFAULT_MODEL
}) {
  if (!studentAnswer) {
    return studentAnswer;
  }

  const prompt = buildNormalizationPrompt({ studentAnswer });
  const content = await callOpenai({ model, prompt, jsonMode: false });
  const cleaned = content.trim();

  if (!cleaned) {
    return studentAnswer;
  }

  const rawLength = studentAnswer.length;
  const cleanedLength = cleaned.length;
  const maxAllowed = Math.ceil(rawLength * 1.4);
  const minAllowed = Math.floor(rawLength * 0.5);
  const overlap = tokenJaccard(studentAnswer, cleaned);

  if (cleanedLength > maxAllowed || cleanedLength < minAllowed || overlap < 0.4) {
    return studentAnswer;
  }

  return cleaned;
}

export async function llmScoreAnswerOpenAI({
  question,
  studentAnswer,
  referenceChunks,
  rubricScore,
  mode = "adjust",
  model = DEFAULT_MODEL
}) {
  const referenceText = referenceChunks
    ? referenceChunks
        .map((chunk) => chunk.content)
        .filter(Boolean)
        .join("\n---\n")
    : "";

  const prompt =
    mode === "score"
      ? buildScorePrompt({ question, studentAnswer })
      : buildAdjustPrompt({ question, studentAnswer, referenceText, rubricScore });

  const content = await callOpenai({ model, prompt, jsonMode: true });
  const parsed = safeParseJson(content);

  if (!parsed) {
    throw new Error("OpenAI response was not valid JSON.");
  }

  return parsed;
}
