import express from "express";
import { evaluateAnswer } from "../evaluation/index.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { subject, domain, question, answerText } = req.body || {};

    if (!answerText) {
      return res.status(400).json({
        success: false,
        error: "answerText is required"
      });
    }

    const evaluation = await evaluateAnswer({
      subject,
      domain,
      question,
      answerText
    });

    return res.json({
      success: true,
      evaluation
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: "Failed to evaluate answer"
    });
  }
});

export default router;
