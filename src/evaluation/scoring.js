import { extractKeywords } from "./keywords.js";

function uniqueMerge(lists) {
  const merged = new Set();
  for (const list of lists) {
    for (const item of list) {
      merged.add(item);
    }
  }
  return [...merged];
}

export function scoreAnswer({
  studentAnswer,
  retrievedChunks,
  similarityScores
}) {
  const studentKeywords = extractKeywords(studentAnswer);
  const referenceKeywords = uniqueMerge(
    retrievedChunks.map((chunk) => extractKeywords(chunk.content))
  );

  const keyPoints = uniqueMerge(
    retrievedChunks.map((chunk) => extractKeyPoints(chunk.content))
  );

  const refSet = new Set(referenceKeywords);
  const studentSet = new Set(studentKeywords);

  let overlap = 0;
  for (const keyword of refSet) {
    if (studentSet.has(keyword)) {
      overlap += 1;
    }
  }

  const coverage = refSet.size === 0 ? 0 : overlap / refSet.size;
  const similarityAverage =
    similarityScores.length === 0
      ? 0
      : similarityScores.reduce((sum, value) => sum + value, 0) /
        similarityScores.length;

  const keyPointCoverage = scoreKeyPointCoverage(
    keyPoints,
    studentKeywords
  );
  const structureScore = scoreStructure(studentAnswer);

  const weighted =
    0.4 * similarityAverage + 0.3 * coverage + 0.2 * keyPointCoverage + 0.1 * structureScore;
  const score = Math.round(weighted * 10 * 10) / 10;
  const missingKeywords = referenceKeywords.filter(
    (keyword) => !studentSet.has(keyword)
  );

  return {
    score,
    coverage,
    similarityAverage,
    keyPointCoverage,
    structureScore,
    studentKeywords,
    missingKeywords
  };
}

export function scoreLayout(text) {
  return scoreStructure(text);
}

function extractKeyPoints(text) {
  const sentences = (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.slice(0, 5);
}

function scoreKeyPointCoverage(keyPoints, studentKeywords) {
  if (!keyPoints.length) {
    return 0;
  }

  const studentSet = new Set(studentKeywords);
  let matched = 0;

  for (const point of keyPoints) {
    const keywords = extractKeywords(point, 6);
    const hit = keywords.some((keyword) => studentSet.has(keyword));
    if (hit) {
      matched += 1;
    }
  }

  return matched / keyPoints.length;
}

function scoreStructure(text) {
  const lower = (text || "").toLowerCase();
  const hasIntro = lower.includes("introduction") || lower.includes("intro");
  const hasConclusion =
    lower.includes("conclusion") ||
    lower.includes("in conclusion") ||
    lower.includes("to conclude");
  const paragraphCount = (text || "").split(/\n{2,}/).filter(Boolean).length;

  let score = 0;
  if (hasIntro) score += 0.4;
  if (hasConclusion) score += 0.4;
  if (paragraphCount >= 2) score += 0.2;

  return Math.min(score, 1);
}
