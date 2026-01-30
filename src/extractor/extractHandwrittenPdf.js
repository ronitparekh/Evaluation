import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

const pythonBin =
  process.env.PYTHON_BIN ||
  (fs.existsSync(".venv311/Scripts/python.exe")
    ? ".venv311/Scripts/python.exe"
    : "python");

function runTrOcr(linePaths) {
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

export default async function extractHandwrittenPdf(pdfPath) {
  const pdfPagesDir = "temp/pdf_pages";
  const lineDir = "temp/line_segments";

  [pdfPagesDir, lineDir].forEach(d =>
    fs.rmSync(d, { recursive: true, force: true })
  );

  fs.mkdirSync(pdfPagesDir, { recursive: true });
  fs.mkdirSync(lineDir, { recursive: true });

 
  execSync(
    `pdftoppm "${pdfPath}" "${pdfPagesDir}/page" -png -r 300`,
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


    let output;
    try {
      output = execSync(
        `"${pythonBin}" python/lineSegment.py "${pagePath}" "${lineDir}"`,
        { encoding: "utf-8", timeout: 20000 }
      );
    } catch (err) {
      console.error("Line segmentation failed:", err.message);
      if (err.stderr) console.error("STDERR:", err.stderr);
      continue;
    }

    const linePaths = output
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);

    console.log(`   Found ${linePaths.length} line segments`);


    if (linePaths.length) {
      try {
        const text = await runTrOcr(linePaths);
        if (text) finalText += text + "\n";
      } catch (err) {
        console.error("OCR failed:", err.message);
      }
    }

    finalText += "\n";
  }

  return finalText.trim();
}
