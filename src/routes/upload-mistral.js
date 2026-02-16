import express from "express";
import multer from "multer";
import fs from "fs";
import extractPdfWithMistral from "../extractor/mistralPdfPipeline.js";
import { evaluateAnswer } from "../evaluation/index.js";
import { evaluateAnswerOpenAI } from "../evaluation/index-openai.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No PDF uploaded" });
  }

  const { question, subject, domain, maxMarks } = req.body || {};
  const metadata = {
    question,
    subject,
    domain,
    maxMarks: maxMarks ? Number(maxMarks) : undefined
  };

  try {
    const { text, diagrams } = await extractPdfWithMistral(req.file.path);
    const summary = {
      metadata,
      localRubric: null,
      localRubricError: null,
      openaiLLM: null,
      openaiError: null,
      diagrams: diagrams
        ? diagrams.map(diagram => ({
            id: diagram.id,
            fileName: diagram.fileName,
            pageIndex: diagram.pageIndex
          }))
        : []
    };

    try {
      summary.localRubric = await evaluateAnswer({
        ...metadata,
        answerText: text,
        enableLLM: false,
        enableNormalization: false
      });
    } catch (error) {
      summary.localRubricError = error.message || String(error);
    }

    try {
      summary.openaiLLM = await evaluateAnswerOpenAI({
        ...metadata,
        answerText: text,
        enableNormalization: false
      });
    } catch (error) {
      summary.openaiError = error.message || String(error);
    }

    res.json({
      success: true,
      text,
      diagrams,
      evaluation: summary
    });
  } catch (error) {
    console.error("Mistral upload failed:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to process with Mistral",
      details: error.raw || null
    });
  } finally {
    try {
      fs.unlinkSync(req.file.path);
    } catch (cleanupErr) {
      console.warn("Failed to remove uploaded file", cleanupErr.message || cleanupErr);
    }
  }
});

export default router;
