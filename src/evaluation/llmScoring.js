// const DEFAULT_OLLAMA_URL = "http://localhost:11434/api/generate";
// const DEFAULT_MODEL = "qwen2.5:7b";

// function buildPrompt({ question, studentAnswer, referenceText, rubricScore }) {
//   return `
// You are an experienced UPSC examiner evaluating a GS answer.

// IMPORTANT CONTEXT:
// - The student answer is extracted using OCR from a handwritten copy.
// - The text contains spelling mistakes, broken words, missing punctuation, and lost formatting.
// - DO NOT penalize spelling, grammar, handwriting, or OCR artifacts.
// - Mentally normalize incorrect words to the closest valid UPSC / polity / governance terms, remaining UPSC domains.
//   (Example: "Yanchayati Kay" → "Panchayati Raj", "subsidianity" → "subsidiarity")

// EVALUATION RULES:
// - Focus ONLY on semantic meaning, conceptual correctness, and coverage of key points.
// - Try to reconstruct the intended structure (introduction, body, conclusion) even if formatting is lost.
// - If statements logically connect into arguments or explanations, give credit for structure.
// - Award POSITIVE marks if the intent is correct, even if expression is poor.
// - NEVER reduce the score. You may only add marks.
// - If unsure, return score_adjustment = 0.
// - Do NOT list spelling issues unless they change meaning.
//   If normalization was applied, return an empty spelling_issues array.

// OUTPUT FORMAT (STRICT):
// Return ONLY valid JSON with the following keys:
// - score_adjustment: number between 0 and +2 (integer or decimal)
// - feedback: short examiner-style paragraph
// - strengths: array of short bullet points
// - weaknesses: array of short bullet points (conceptual only, not language)


// QUESTION:
// ${question || "(not provided)"}

// REFERENCE MATERIAL (for correctness & coverage):
// ${referenceText}

// STUDENT ANSWER (OCR-normalized, reconstructed text):
// ${studentAnswer}

// CURRENT RUBRIC SCORE (0–10):
// ${rubricScore}
// `;
// }

// function buildNormalizationPrompt({ studentAnswer }) {
//   return `You are cleaning OCR-extracted handwritten UPSC answers. Do not add or remove ideas. Only fix spelling, broken words, and sentence continuity. Restore intended UPSC terms where obvious. If unsure, keep original wording. Output only the cleaned answer.

// RAW OCR ANSWER:
// ${studentAnswer}
// `;
// }


// function safeParseJson(text) {
//   if (!text) {
//     return null;
//   }

//   const cleaned = text
//     .replace(/```json\s*/i, "")
//     .replace(/```/g, "")
//     .trim();

//   const firstBrace = cleaned.indexOf("{");
//   const lastBrace = cleaned.lastIndexOf("}");
//   const jsonSlice =
//     firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
//       ? cleaned.slice(firstBrace, lastBrace + 1)
//       : cleaned;

//   try {
//     return JSON.parse(jsonSlice);
//   } catch {
//     return null;
//   }
// }

// export async function llmScoreAnswer({
//   question,
//   studentAnswer,
//   referenceChunks,
//   rubricScore,
//   ollamaUrl = DEFAULT_OLLAMA_URL,
//   model = DEFAULT_MODEL
// }) {
//   const referenceText = referenceChunks
//     .map((chunk) => chunk.content)
//     .filter(Boolean)
//     .join("\n---\n");

//   const prompt = buildPrompt({
//     question,
//     studentAnswer,
//     referenceText,
//     rubricScore
//   });

//   const response = await fetch(ollamaUrl, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       model,
//       prompt,
//       stream: false,
//       format: "json"
//     })
//   });

//   if (!response.ok) {
//     const errorText = await response.text();
//     throw new Error(`LLM request failed: ${response.status} ${errorText}`);
//   }

//   const data = await response.json();
//   const parsed = safeParseJson(data?.response || "");

//   if (!parsed) {
//     throw new Error("LLM response was not valid JSON.");
//   }

//   return parsed;
// }

// function tokenJaccard(a, b) {
//   const toTokens = (value) =>
//     new Set(
//       (value || "")
//         .toLowerCase()
//         .replace(/[^a-z0-9\s]/g, " ")
//         .split(/\s+/)
//         .filter(Boolean)
//     );

//   const setA = toTokens(a);
//   const setB = toTokens(b);
//   if (setA.size === 0 || setB.size === 0) {
//     return 0;
//   }

//   let intersection = 0;
//   for (const token of setA) {
//     if (setB.has(token)) {
//       intersection += 1;
//     }
//   }

//   const union = setA.size + setB.size - intersection;
//   return union === 0 ? 0 : intersection / union;
// }

// export async function normalizeAnswerWithLLM({
//   studentAnswer,
//   ollamaUrl = DEFAULT_OLLAMA_URL,
//   model = DEFAULT_MODEL
// }) {
//   if (!studentAnswer) {
//     return studentAnswer;
//   }

//   const prompt = buildNormalizationPrompt({ studentAnswer });
//   const response = await fetch(ollamaUrl, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       model,
//       prompt,
//       stream: false
//     })
//   });

//   if (!response.ok) {
//     throw new Error(`LLM normalization failed: ${response.status}`);
//   }

//   const data = await response.json();
//   const cleaned = (data?.response || "").trim();

//   if (!cleaned) {
//     return studentAnswer;
//   }

//   const rawLength = studentAnswer.length;
//   const cleanedLength = cleaned.length;
//   const maxAllowed = Math.ceil(rawLength * 1.15);
//   const minAllowed = Math.floor(rawLength * 0.6);
//   const overlap = tokenJaccard(studentAnswer, cleaned);

//   if (cleanedLength > maxAllowed || cleanedLength < minAllowed || overlap < 0.4) {
//     return studentAnswer;
//   }

//   return cleaned;
// }

const DEFAULT_OLLAMA_URL = "http://localhost:11434/api/generate";
const DEFAULT_MODEL = "qwen2.5:7b";

function buildAdjustPrompt({ question, studentAnswer, referenceText, rubricScore }) {
  return `
You are an experienced UPSC GS examiner ASSISTING an automated scoring system.

IMPORTANT CONTEXT:
- Student answer is OCR-extracted handwritten text.
- Contains spelling errors, broken words, missing structure.
- DO NOT penalize language, handwriting, spelling or OCR artifacts.
- Normalize incorrect words mentally to closest UPSC terms
  (e.g., "subsidianity" → "subsidiarity").

YOUR ROLE:
- The system has already given a BASE rubric score.
- You may ONLY ENHANCE the score if deserved.
- NEVER reduce marks.
- If unsure, return score_adjustment = 0.

EVALUATION GUIDELINES:
- Reward:
  • correct definitions
  • relevant constitutional provisions
  • examples (including diagrams if implied)
  • logical flow even if formatting is lost
- Assume standard UPSC structure unless clearly absent.
- Reward intent and conceptual clarity over precision.

SCORING RULES:
- score_adjustment: 0 → +2
- Use:
  +0.5 to +1 for partial improvement
  +1 to +2 for clear conceptual depth

OUTPUT FORMAT (STRICT JSON ONLY):
{
  "score_adjustment": number,
  "confidence": number between 0 and 1
}

QUESTION:
${question}

REFERENCE MATERIAL:
${referenceText}

STUDENT ANSWER (OCR TEXT):
${studentAnswer}

CURRENT RUBRIC SCORE (0–10):
${rubricScore}
`;
}


function buildScorePrompt({ question, studentAnswer }) {
  return `
You are an experienced UPSC GS examiner.

IMPORTANT CONTEXT:
- The answer is OCR-extracted from a handwritten script.
- Text contains spelling errors, broken words, missing punctuation and lost structure.
- DO NOT penalize spelling, grammar, handwriting or OCR noise.
- Mentally normalize words to closest valid UPSC terms
  (e.g., "Yanchayati Raj" → "Panchayati Raj").

EVALUATION RULES:
- Focus ONLY on:
  • relevance to the question
  • conceptual understanding
  • examples / diagrams (assume diagrams exist if implied)
- Reward INTENT even if expression is weak.
- Give PARTIAL CREDIT generously.
- Assume the student attempted a standard UPSC structure even if formatting is lost.
- Do NOT compare with model answers line-by-line.

SCORING:
- Score range: 0–10
- 4–5 = basic understanding
- 6–7 = decent answer with gaps
- 8–9 = strong answer
- 10 = near-perfect

OUTPUT FORMAT (STRICT JSON ONLY):
{
  "score": number,
  "confidence": number between 0 and 1
}

QUESTION:
${question || "(not provided)"}

STUDENT ANSWER (OCR TEXT):
${studentAnswer}
`;
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

export async function normalizeAnswerWithLLM({
	studentAnswer,
	ollamaUrl = DEFAULT_OLLAMA_URL,
	model = DEFAULT_MODEL
}) {
	if (!studentAnswer) {
		return studentAnswer;
	}

	const prompt = buildNormalizationPrompt({ studentAnswer });
	const response = await fetch(ollamaUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			prompt,
			stream: false
		})
	});

	if (!response.ok) {
		throw new Error(`LLM normalization failed: ${response.status}`);
	}

	const data = await response.json();
	const cleaned = (data?.response || "").trim();

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

export async function llmScoreAnswer({
	question,
	studentAnswer,
	referenceChunks,
	rubricScore,
	mode = "adjust",
	ollamaUrl = DEFAULT_OLLAMA_URL,
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

	const response = await fetch(ollamaUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			prompt,
			stream: false,
			format: "json"
		})
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`LLM request failed: ${response.status} ${errorText}`);
	}

	const data = await response.json();
	const parsed = safeParseJson(data?.response || "");

	if (!parsed) {
		throw new Error("LLM response was not valid JSON.");
	}

	return parsed;
}
