import express from "express";
import multer from "multer";
import fs from "fs";
import extractPdf from "../extractor/index.js";
import { evaluateAnswerOpenAI } from "../evaluation/index-openai.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const extractedText = await extractPdf(req.file.path);
    const { question, subject, domain, maxMarks } = req.body || {};
    const evaluation = await evaluateAnswerOpenAI({
      subject,
      domain,
      question,
      answerText: extractedText,
      maxMarks: maxMarks ? Number(maxMarks) : undefined
    });

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      text: extractedText,
      evaluation
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err?.message || "Failed to extract text"
    });
  }
});

export default router;
