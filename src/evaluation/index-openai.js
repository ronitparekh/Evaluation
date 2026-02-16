import fs from "fs";
import path from "path";
import { embedText, cosineSimilarity } from "./embeddings.js";
import { loadReferenceData } from "./referenceStore.js";
import { scoreAnswer, scoreLayout } from "./scoring.js";
import { llmScoreAnswerOpenAI, normalizeAnswerWithOpenAI } from "./llmScoringOpenai.js";

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

function matchesFilter(value, filterValue) {
  if (!filterValue) {
    return true;
  }
  return value.toLowerCase() === filterValue.toLowerCase();
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

export async function evaluateAnswerOpenAI({
  subject,
  domain,
  question,
  answerText,
  maxMarks = 10,
  enableNormalization
}) {
  const referenceIndex = await getReferenceIndex();
  const trimmedAnswer = normalizeText(answerText);

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const normalizeEnabled =
    typeof enableNormalization === "boolean"
      ? enableNormalization
      : process.env.OPENAI_NORMALIZE === "true";

  let normalizedAnswer = trimmedAnswer;
  if (normalizeEnabled) {
    try {
      normalizedAnswer = await normalizeAnswerWithOpenAI({
        studentAnswer: trimmedAnswer,
        model
      });
    } catch {
      normalizedAnswer = trimmedAnswer;
    }
  }

  writeOcrOutputs(trimmedAnswer, normalizedAnswer);

  const baseLayoutScore = scoreLayout(normalizedAnswer) * 10;
  let layoutScore = baseLayoutScore;
  let visualScore = 0;

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

    try {
      const llmResult = await llmScoreAnswerOpenAI({
        question,
        studentAnswer: normalizedAnswer,
        referenceChunks: retrievedChunks,
        rubricScore: scored.score,
        mode: "adjust",
        model
      });

      const adjustment =
        llmResult && typeof llmResult.score_adjustment === "number"
          ? Math.max(0, Math.min(2, llmResult.score_adjustment))
          : 0;
      finalScore = Math.max(0, Math.min(10, textScore + adjustment));
      if (typeof llmResult.confidence === "number") {
        confidence = llmResult.confidence;
      }
      if (typeof llmResult.layout_score === "number") {
        layoutScore = llmResult.layout_score;
      }
      if (typeof llmResult.visual_score === "number") {
        visualScore = llmResult.visual_score;
      }
    } catch {
      confidence = matchScore;
    }
  } else {
    try {
      const llmResult = await llmScoreAnswerOpenAI({
        question,
        studentAnswer: normalizedAnswer,
        referenceChunks: null,
        rubricScore: null,
        mode: "score",
        model
      });

      if (typeof llmResult.score === "number") {
        textScore = Math.max(0, Math.min(10, llmResult.score));
        finalScore = textScore;
      }
      if (typeof llmResult.confidence === "number") {
        confidence = llmResult.confidence;
      }
      if (typeof llmResult.layout_score === "number") {
        layoutScore = llmResult.layout_score;
      }
      if (typeof llmResult.visual_score === "number") {
        visualScore = llmResult.visual_score;
      }
    } catch {
      finalScore = 0;
      textScore = 0;
    }
  }

  return {
    finalScore: Math.max(0, Math.min(10, finalScore)),
    TextScore: Math.max(0, Math.min(10, textScore)),
    VisualScore: Math.max(0, Math.min(10, visualScore)),
    LayoutScore: Math.max(0, Math.min(10, layoutScore)),
    Confidence: Math.max(0, Math.min(10, confidence * 10))
  };
}
