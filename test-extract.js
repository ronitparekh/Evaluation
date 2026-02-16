import fs from "fs";
import { PDFParse } from "pdf-parse";

const PDF_PATH = "uploads/sample2.pdf";

(async () => {
  const buffer = fs.readFileSync(PDF_PATH);
  const data = await new PDFParse(buffer);
  
  console.log(`Extracted text length: ${data.text.trim().length}`);
  console.log(`\nExtracted text:\n${data.text}`);
})();
