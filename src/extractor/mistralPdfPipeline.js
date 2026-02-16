import fs from "fs";
import https from "https";
import http from "http";
import path from "path";
import { execSync } from "child_process";

const DEFAULT_ENDPOINT = "https://api.mistral.ai/v1/ocr";
const DEFAULT_MODEL = "mistral-ocr-latest";
const DEFAULT_DPI = parseInt(process.env.MISTRAL_OCR_DPI || "250", 10);
const PAGES_DIR = path.join("temp", "mistral_pages");
const DIAGRAM_DIR = path.join("temp", "mistral_diagrams");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const DIAGRAM_SCRIPT = path.join("python", "diagramDetect.py");

function requestJson(urlString, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "https:" ? https : http;

    const body = JSON.stringify(payload);
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers
        },
        timeout: parseInt(process.env.MISTRAL_OCR_TIMEOUT_MS || "120000", 10)
      },
      res => {
        let raw = "";
        res.on("data", chunk => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (res.statusCode && res.statusCode >= 400) {
              const msg =
                parsed?.error?.message ||
                parsed?.message ||
                raw ||
                `Mistral OCR error ${res.statusCode}`;
              const error = new Error(msg);
              error.statusCode = res.statusCode;
              error.raw = raw;
              error.body = parsed;
              reject(error);
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function normalizeText(response) {
  if (!response) return "";
  if (typeof response.text === "string") return response.text.trim();
  if (Array.isArray(response.pages)) {
    return response.pages
      .map(extractPageText)
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (Array.isArray(response.results)) {
    return response.results
      .map(entry => entry?.text || entry?.output || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (Array.isArray(response.outputs)) {
    return response.outputs
      .map(entry => entry?.text || entry?.output || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function extractPageText(page) {
  if (!page || typeof page !== "object") return "";
  const fields = [page.markdown, page.text, page.output];
  const direct = fields.find(val => typeof val === "string" && val.trim());
  if (direct) return direct.trim();
  if (Array.isArray(page.lines)) {
    const lineText = page.lines
      .map(line => line?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (lineText) return lineText;
  }
  return "";
}

function encodeDiagram(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn("Failed to read diagram file", filePath, err.message || err);
    return null;
  }
}

function gatherDiagrams(pagePaths) {
  fs.rmSync(DIAGRAM_DIR, { recursive: true, force: true });
  const diagrams = [];

  for (let index = 0; index < pagePaths.length; index += 1) {
    const pagePath = pagePaths[index];
    const pageDir = path.join(DIAGRAM_DIR, `page_${index + 1}`);
    fs.mkdirSync(pageDir, { recursive: true });

    if (!fs.existsSync(DIAGRAM_SCRIPT)) {
      continue;
    }

    try {
      execSync(
        `"${PYTHON_BIN}" "${DIAGRAM_SCRIPT}" "${pagePath}" "${pageDir}"`,
        { stdio: "ignore" }
      );
    } catch (err) {
      console.warn("Diagram detection failed", err.message || err);
    }

    const pageFiles = fs
      .readdirSync(pageDir)
      .filter(name => name.toLowerCase().endsWith(".png"));

    pageFiles.forEach((fileName, fileIndex) => {
      const absolutePath = path.join(pageDir, fileName);
      diagrams.push({
        id: `${index + 1}-${fileIndex + 1}`,
        pageIndex: index,
        fileName,
        path: absolutePath,
        dataUrl: encodeDiagram(absolutePath)
      });
    });
  }

  return diagrams;
}

function buildDiagramSection(diagrams) {
  if (!diagrams.length) return "";
  const lines = ["---", "Attached Diagrams:"];
  diagrams.forEach((diagram, idx) => {
    lines.push(
      `- Diagram ${idx + 1} (page ${diagram.pageIndex + 1}): ${diagram.fileName}`
    );
  });
  return lines.join("\n");
}

export default async function extractPdfWithMistral(pdfPath) {
  if (!pdfPath) throw new Error("PDF path is required");
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("Set MISTRAL_API_KEY before running Mistral OCR");

  const endpoint = process.env.MISTRAL_OCR_URL || DEFAULT_ENDPOINT;
  const model = process.env.MISTRAL_OCR_MODEL || DEFAULT_MODEL;

  const pagePaths = rasterizePdf(pdfPath);

  if (!pagePaths.length) {
    throw new Error("No pages were generated from the PDF");
  }

  let durationMs = 0;
  const rawResponses = [];
  const texts = [];

  for (const pagePath of pagePaths) {
    const base64 = fs.readFileSync(pagePath).toString("base64");
    const payload = {
      model,
      document: {
        type: "image_url",
        image_url: `data:image/png;base64,${base64}`
      }
    };

    const start = Date.now();
    const response = await requestJson(endpoint, payload, {
      Authorization: `Bearer ${apiKey}`
    });
    durationMs += Date.now() - start;
    rawResponses.push(response);
    texts.push(normalizeText(response));
  }

  const diagramEntries = gatherDiagrams(pagePaths).filter(d => d.dataUrl);
  const diagramSection = buildDiagramSection(diagramEntries);
  const textParts = texts.filter(Boolean);
  if (diagramSection) {
    textParts.push(diagramSection);
  }

  return {
    text: textParts.join("\n\n"),
    durationMs,
    raw: rawResponses,
    diagrams: diagramEntries
  };
}

function rasterizePdf(pdfPath) {
  fs.rmSync(PAGES_DIR, { recursive: true, force: true });
  fs.mkdirSync(PAGES_DIR, { recursive: true });

  const dpi = DEFAULT_DPI;
  const outputPrefix = path.join(PAGES_DIR, "page");
  try {
    execSync(`pdftoppm "${pdfPath}" "${outputPrefix}" -png -r ${dpi}`, {
      stdio: "ignore"
    });
  } catch (err) {
    throw new Error(
      "Failed to rasterize PDF. Ensure `pdftoppm` is installed and on PATH."
    );
  }

  return fs
    .readdirSync(PAGES_DIR)
    .filter(name => name.endsWith(".png"))
    .sort()
    .map(name => path.join(PAGES_DIR, name));
}
