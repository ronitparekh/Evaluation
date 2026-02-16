import fs from "fs";
import path from "path";
import { embedText, cosineSimilarity } from "./embeddings.js";
import { loadReferenceData } from "./referenceStore.js";
import { scoreAnswer, scoreLayout } from "./scoring.js";
import { llmScoreAnswer, normalizeAnswerWithLLM } from "./llmScoring.js";

let cachedIndex = null;

function normalizeText(value) {
  return (value || "").toString().trim();
}

function normalizeReferenceItem(item, fallbackId) {
  return {
    id: item.id ?? fallbackId,
    subject: normalizeText(item.subject),
    domain: normalizeText(item.domain),
    question: normalizeText(item.question),
    answerText: normalizeText(item.answer_text || item.answerText),
    type: normalizeText(item.type || item.source || "reference")
  };
}

async function buildIndex(rawItems) {
  const items = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index];
    const normalized = normalizeReferenceItem(item, index + 1);
    const content = [normalized.question, normalized.answerText]
      .filter(Boolean)
      .join("\n");
    const embedding = await embedText(content);
    const questionEmbedding = normalized.question
      ? await embedText(normalized.question)
      : [];

    items.push({
      ...normalized,
      content,
      embedding,
      questionEmbedding
    });
  }

  return items;
}

async function getReferenceIndex() {
  if (cachedIndex && cachedIndex.length > 0) {
    return cachedIndex;
  }

  const rawItems = loadReferenceData();
  cachedIndex = await buildIndex(rawItems);
  return cachedIndex;
}

function writeOcrOutputs(rawText, normalizedText) {
  const baseDir = path.resolve("temp", "ocr_texts");
  fs.mkdirSync(baseDir, { recursive: true });

  const existingFiles = fs.readdirSync(baseDir);
  for (const file of existingFiles) {
    if (file.startsWith("ocr_") && file.endsWith(".txt")) {
      fs.rmSync(path.join(baseDir, file), { force: true });
    }
  }

  const stamp = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const rawPath = path.join(baseDir, `ocr_${stamp}_raw.txt`);
  const normalizedPath = path.join(baseDir, `ocr_${stamp}_normalized.txt`);

  fs.writeFileSync(rawPath, rawText || "", "utf-8");
  fs.writeFileSync(normalizedPath, normalizedText || "", "utf-8");

  return { rawPath, normalizedPath };
}

function matchesFilter(value, filterValue) {
  if (!filterValue) {
    return true;
  }
  return value.toLowerCase() === filterValue.toLowerCase();
}

function retrieveTopK({ index, queryEmbedding, subject, domain, topK }) {
  const filtered = index.filter(
    (item) =>
      matchesFilter(item.subject, subject) && matchesFilter(item.domain, domain)
  );

  const scored = filtered.map((item) => ({
    item,
    score: cosineSimilarity(queryEmbedding, item.embedding)
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

function findBestQuestionMatch({ index, questionEmbedding, subject, domain }) {
  const filtered = index.filter(
    (item) =>
      matchesFilter(item.subject, subject) && matchesFilter(item.domain, domain)
  );

  let best = null;
  for (const item of filtered) {
    if (!item.questionEmbedding || item.questionEmbedding.length === 0) {
      continue;
    }
    const score = cosineSimilarity(questionEmbedding, item.questionEmbedding);
    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  return best;
}

export async function evaluateAnswer({
  subject,
  domain,
  question,
  answerText,
  topK = 5,
  maxMarks = 10,
  enableLLM,
  enableNormalization
}) {
  const referenceIndex = await getReferenceIndex();
  const trimmedAnswer = normalizeText(answerText);

  const llmEnabled =
    typeof enableLLM === "boolean"
      ? enableLLM
      : process.env.LLM_ENABLED === "true";
  const ollamaModel = process.env.LLM_MODEL;
  const normalizeEnabled =
    typeof enableNormalization === "boolean"
      ? enableNormalization
      : llmEnabled && process.env.LLM_NORMALIZE === "true";

  let normalizedAnswer = trimmedAnswer;
  let normalizationError = null;

  if (normalizeEnabled) {
    try {
      normalizedAnswer = await normalizeAnswerWithLLM({
        studentAnswer: trimmedAnswer,
        model: ollamaModel || undefined
      });
    } catch (error) {
      normalizationError = error.message;
      normalizedAnswer = trimmedAnswer;
    }
  }

  const ocrPaths = writeOcrOutputs(trimmedAnswer, normalizedAnswer);

  const layoutScore = scoreLayout(normalizedAnswer);
  const visualScore = trimmedAnswer.includes("[DIAGRAM DETECTED") ? 1 : 0;

  const questionText = normalizeText(question);
  const questionEmbedding = questionText ? await embedText(questionText) : [];
  const bestMatch =
    questionEmbedding.length > 0 && referenceIndex.length > 0
      ? findBestQuestionMatch({
          index: referenceIndex,
          questionEmbedding,
          subject,
          domain
        })
      : null;

  const matchScore = bestMatch ? bestMatch.score : 0;
  const matchThreshold = 0.7;

  let textScore = 0;
  let finalScore = 0;
  let confidence = matchScore;

  if (bestMatch && matchScore >= matchThreshold) {
    const retrievedChunks = [
      {
        id: bestMatch.item.id,
        subject: bestMatch.item.subject,
        domain: bestMatch.item.domain,
        question: bestMatch.item.question,
        type: bestMatch.item.type,
        content: bestMatch.item.content,
        similarity: matchScore
      }
    ];

    const scored = scoreAnswer({
      studentAnswer: normalizedAnswer,
      retrievedChunks,
      similarityScores: [matchScore]
    });

    textScore = scored.score;
    finalScore = textScore;

    if (llmEnabled) {
      try {
        const llmResult = await llmScoreAnswer({
          question,
          studentAnswer: normalizedAnswer,
          referenceChunks: retrievedChunks,
          rubricScore: scored.score,
          mode: "adjust",
          model: ollamaModel || undefined
        });

        const adjustment =
          llmResult && typeof llmResult.score_adjustment === "number"
            ? Math.max(0, Math.min(2, llmResult.score_adjustment))
            : 0;
        finalScore = Math.max(0, Math.min(10, textScore + adjustment));
        if (typeof llmResult.confidence === "number") {
          confidence = llmResult.confidence;
        }
      } catch {
        confidence = matchScore;
      }
    }
  } else {
    if (llmEnabled) {
      try {
        const llmResult = await llmScoreAnswer({
          question,
          studentAnswer: normalizedAnswer,
          referenceChunks: null,
          rubricScore: null,
          mode: "score",
          model: ollamaModel || undefined
        });

        if (typeof llmResult.score === "number") {
          textScore = Math.max(0, Math.min(10, llmResult.score));
          finalScore = textScore;
        }
        if (typeof llmResult.confidence === "number") {
          confidence = llmResult.confidence;
        }
      } catch {
        finalScore = 0;
        textScore = 0;
      }
    }
  }

  return {
    finalScore: Math.max(0, Math.min(10, finalScore)),
    TextScore: Math.max(0, Math.min(10, textScore)),
    VisualScore: Math.max(0, Math.min(10, visualScore * 10)),
    LayoutScore: Math.max(0, Math.min(10, layoutScore * 10)),
    Confidence: Math.max(0, Math.min(10, confidence * 10)),
    rawOcrPath: ocrPaths.rawPath,
    normalizedPath: ocrPaths.normalizedPath
  };
}
