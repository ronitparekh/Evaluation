import fs from "fs";
import path from "path";
import extractPdfWithMistral from "./mistralPdfPipeline.js";
import { evaluateAnswer } from "../evaluation/index.js";
import { evaluateAnswerOpenAI } from "../evaluation/index-openai.js";

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      const key = arg.slice(2, eq);
      const value = arg.slice(eq + 1);
      flags[key] = value;
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  }

  return { positional, flags };
}

function toBoolean(value, defaultValue = true) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  return defaultValue;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJsonSafe(filePath) {
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Failed to load metadata file ${filePath}:`, error.message || error);
    return {};
  }
}

function pickMetadataValue(key, flags, fileConfig, envKey) {
  if (flags[key] !== undefined) {
    return flags[key];
  }
  if (fileConfig[key] !== undefined) {
    return fileConfig[key];
  }
  if (envKey && process.env[envKey] !== undefined) {
    return process.env[envKey];
  }
  return undefined;
}

function buildMetadata(flags) {
  const configPath =
    flags.config || flags.meta || process.env.MISTRAL_EVAL_CONFIG || process.env.EVAL_CONFIG;
  const fileConfig = configPath ? readJsonSafe(configPath) : {};

  const metadata = {};
  const question = pickMetadataValue("question", flags, fileConfig, "EVAL_QUESTION");
  const subject = pickMetadataValue("subject", flags, fileConfig, "EVAL_SUBJECT");
  const domain = pickMetadataValue("domain", flags, fileConfig, "EVAL_DOMAIN");
  const maxMarksValue = pickMetadataValue("maxMarks", flags, fileConfig, "EVAL_MAX_MARKS");

  if (question) metadata.question = question;
  if (subject) metadata.subject = subject;
  if (domain) metadata.domain = domain;
  if (maxMarksValue !== undefined) {
    const parsed = Number(maxMarksValue);
    if (!Number.isNaN(parsed)) {
      metadata.maxMarks = parsed;
    }
  }

  return metadata;
}

function logEvaluationBlock(label, result) {
  if (!result) return;
  console.log(`\n--- ${label} ---`);
  console.log(
    JSON.stringify(
      {
        FinalScore: result.finalScore,
        TextScore: result.TextScore,
        VisualScore: result.VisualScore,
        LayoutScore: result.LayoutScore,
        Confidence: result.Confidence
      },
      null,
      2
    )
  );
}

async function runEvaluations({ text, metadata, diagrams, outputDir }) {
  const summary = {
    metadata,
    generatedAt: new Date().toISOString()
  };

  if (diagrams && diagrams.length) {
    summary.diagrams = diagrams.map(diagram => ({
      id: diagram.id,
      fileName: diagram.fileName,
      pageIndex: diagram.pageIndex
    }));
  }

  try {
    summary.localRubric = await evaluateAnswer({
      ...metadata,
      answerText: text,
      enableLLM: false,
      enableNormalization: false
    });
  } catch (error) {
    summary.localRubricError = error.message || String(error);
    console.error("Local rubric evaluation failed:", summary.localRubricError);
  }

  try {
    summary.openaiLLM = await evaluateAnswerOpenAI({
      ...metadata,
      answerText: text,
      enableNormalization: false
    });
  } catch (error) {
    summary.openaiError = error.message || String(error);
    console.error("OpenAI evaluation failed:", summary.openaiError);
  }

  ensureDir(outputDir);
  const evalPath = path.join(outputDir, "mistral_evaluation.json");
  fs.writeFileSync(evalPath, JSON.stringify(summary, null, 2));
  console.log(`Saved evaluation summary to ${evalPath}`);

  return summary;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const pdfPath = positional[0] || "uploads/sample 9.pdf";
  const outputPath = positional[1] || path.join("temp", "mistral_output.txt");
  const outputDir = path.dirname(outputPath);

  console.log(`Using PDF: ${pdfPath}`);
  try {
    const { text, durationMs, raw, diagrams } = await extractPdfWithMistral(pdfPath);
    console.log(`Mistral OCR completed in ${durationMs}ms`);

    ensureDir(outputDir);
    fs.writeFileSync(outputPath, text || "", "utf8");
    console.log(`Saved plain text output to ${outputPath}`);

    const rawPath = outputPath.replace(/\.txt$/, "_raw.json");
    fs.writeFileSync(rawPath, JSON.stringify({ raw, diagrams }, null, 2));
    console.log(`Saved raw API response to ${rawPath}`);

    const shouldEvaluate = toBoolean(
      flags.eval ?? flags.evaluate ?? process.env.MISTRAL_EVAL,
      true
    );

    if (shouldEvaluate) {
      const metadata = buildMetadata(flags);
      const summary = await runEvaluations({ text, metadata, diagrams, outputDir });
      logEvaluationBlock("Local Rubric", summary?.localRubric);
      logEvaluationBlock("OpenAI LLM", summary?.openaiLLM);
    } else {
      console.log("Evaluation disabled. Pass --eval=true to re-enable if needed.");
    }

    console.log("\n--- Extracted Text Preview ---");
    console.log(text || "(empty response)");
  } catch (err) {
    console.error("Mistral OCR run failed:", err?.message || err);
    const rawSnippet = err?.raw
      ? err.raw.slice(0, 2000) + (err.raw.length > 2000 ? "..." : "")
      : null;
    const bodyString = err?.body ? JSON.stringify(err.body, null, 2) : null;
    const bodySnippet = bodyString
      ? bodyString.slice(0, 2000) + (bodyString.length > 2000 ? "..." : "")
      : null;

    if (rawSnippet) console.error("Raw error response:", rawSnippet);
    if (bodySnippet) console.error("Parsed error body:", bodySnippet);
    try {
      const logDir = path.join("temp");
      ensureDir(logDir);
      const errorPath = path.join(logDir, "mistral_error.log");
      const payload = {
        message: err?.message || String(err),
        rawSnippet,
        bodySnippet
      };
      fs.writeFileSync(errorPath, JSON.stringify(payload, null, 2));
      console.error(`Saved error details to ${errorPath}`);
    } catch (logErr) {
      console.error("Failed to write mistral_error.log:", logErr.message || logErr);
    }
    process.exit(1);
  }
}

main();
