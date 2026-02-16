import express from "express";
import uploadRouter from "./routes/upload.js";
import evaluateRouter from "./routes/evaluate.js";
import uploadOpenAiRouter from "./routes/upload-openai.js";
import evaluateOpenAiRouter from "./routes/evaluate-openai.js";
import uploadOpenaiRouter from "./routes/upload-openai.js";
import evaluateOpenaiRouter from "./routes/evaluate-openai.js";
import uploadMistralRouter from "./routes/upload-mistral.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/upload", uploadRouter);
app.use("/evaluate", evaluateRouter);
app.use("/upload-openai", uploadOpenAiRouter);
app.use("/evaluate-openai", evaluateOpenAiRouter);
app.use("/upload-openai", uploadOpenaiRouter);
app.use("/evaluate-openai", evaluateOpenaiRouter);
app.use("/upload-mistral", uploadMistralRouter);

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
