import { execSync, spawn } from "child_process";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { URL } from "url";

const pythonBin =
  process.env.PYTHON_BIN ||
  (fs.existsSync(".venv311/Scripts/python.exe")
    ? ".venv311/Scripts/python.exe"
    : "python");

const TROCR_URL = process.env.TROCR_URL || "http://127.0.0.1:8008/ocr";
const TROCR_HEALTH_URL = process.env.TROCR_HEALTH_URL || "http://127.0.0.1:8008/health";

let serverChecked = false;

function httpRequest(url, method, payload) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === "https:" ? https : http;
    const body = payload ? JSON.stringify(payload) : "";

    const req = lib.request(
      {
        method,
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      res => {
        let data = "";
        res.on("data", chunk => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode || 0, data: parsed });
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function ensureTrocrServer() {
  if (serverChecked) return;
  serverChecked = true;

  const health = await httpRequest(TROCR_HEALTH_URL, "GET");
  if (health.status !== 200) {
    throw new Error("TrOCR server not ready");
  }
}

async function runTrOcrWithServer(linePaths) {
  if (!linePaths || !linePaths.length) return "";

  await ensureTrocrServer();

  const response = await httpRequest(TROCR_URL, "POST", { paths: linePaths });
  if (response.status !== 200) {
    throw new Error(response.data?.error || "TrOCR server error");
  }
  if (response.data?.error) {
    throw new Error(response.data.error);
  }
  return (response.data?.results || []).join("\n");
}

async function runTrOcrWithServerImages(images) {
  if (!images || !images.length) return "";

  await ensureTrocrServer();

  const response = await httpRequest(TROCR_URL, "POST", { images });
  if (response.status !== 200) {
    throw new Error(response.data?.error || "TrOCR server error");
  }
  if (response.data?.error) {
    throw new Error(response.data.error);
  }
  return (response.data?.results || []).join("\n");
}

function runTrOcr(linePaths) {
  // Try server first, fallback to original method
  return runTrOcrWithServer(linePaths).catch(err => {
    console.error("Server method failed, using fallback:", err.message);
    return runTrOcrFallback(linePaths);
  });
}

function writeTempImagesFromBase64(images, outputDir) {
  if (!images || !images.length) return [];
  fs.mkdirSync(outputDir, { recursive: true });
  const paths = [];

  for (let i = 0; i < images.length; i += 1) {
    const buffer = Buffer.from(images[i], "base64");
    const outPath = path.join(outputDir, `line_${i}.png`);
    fs.writeFileSync(outPath, buffer);
    paths.push(outPath);
  }

  return paths;
}

function runTrOcrFallback(linePaths) {
  return new Promise((resolve, reject) => {
    if (!linePaths.length) return resolve("");

    const args = ["python/trocr_ocr.py", ...linePaths];

    const proc = spawn(pythonBin, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);

    proc.on("close", code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `TrOCR exited with ${code}`));
      }
    });
  });
}

// No local server lifecycle management here; run the HTTP server separately.

export default async function extractHandwrittenPdf(pdfPath) {
  const pdfPagesDir = "temp/pdf_pages";
  const lineDir = "temp/line_segments";
  const diagramDir = "temp/diagrams";

  [pdfPagesDir, lineDir, diagramDir].forEach(d =>
    fs.rmSync(d, { recursive: true, force: true })
  );

  fs.mkdirSync(pdfPagesDir, { recursive: true });
  fs.mkdirSync(lineDir, { recursive: true });
  fs.mkdirSync(diagramDir, { recursive: true });

  execSync(
    `pdftoppm "${pdfPath}" "${pdfPagesDir}/page" -png -r 250`,
    { stdio: "ignore" }
  );

  let finalText = "";

  const pages = fs
    .readdirSync(pdfPagesDir)
    .filter(f => f.endsWith(".png"))
    .sort();

  console.log(`Found ${pages.length} page(s)`);

  for (const page of pages) {
    const pagePath = path.join(pdfPagesDir, page);
    console.log(`Processing: ${pagePath}`);

    try {
      const diagramOutput = execSync(
        `"${pythonBin}" python/diagramDetect.py "${pagePath}" "${diagramDir}"`,
        { encoding: "utf-8", timeout: 10000 }
      );

      const diagramPaths = diagramOutput
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

      if (diagramPaths.length > 0) {
        console.log(`Found ${diagramPaths.length} diagram(s)`);
        finalText += `[DIAGRAM DETECTED: ${diagramPaths.length}]\n`;
      }
    } catch {

    }

    let output;
    try {
      output = execSync(
        `"${pythonBin}" python/lineSegment.py "${pagePath}" "${lineDir}" --base64`,
        { encoding: "utf-8", timeout: 20000, maxBuffer: 50 * 1024 * 1024 }
      );
    } catch (err) {
      console.error("Line segmentation failed:", err.message);
      continue;
    }

    let images = [];
    try {
      const parsed = JSON.parse(output || "{}");
      images = parsed.images || [];
    } catch (err) {
      console.error("Line segmentation JSON parse failed:", err.message);
      images = [];
    }

    console.log(`   Found ${images.length} line segments`);

    if (images.length) {
      try {
        const text = await runTrOcrWithServerImages(images);
        if (text) finalText += text + "\n";
      } catch (err) {
        console.error("OCR failed, using fallback:", err.message);
        try {
          const fallbackPaths = writeTempImagesFromBase64(images, lineDir);
          const text = await runTrOcr(fallbackPaths);
          if (text) finalText += text + "\n";
        } catch (fallbackErr) {
          console.error("Fallback OCR failed:", fallbackErr.message);
        }
      }
    }

    finalText += "\n";
  }

  return finalText.trim();
}
