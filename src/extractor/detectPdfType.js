import fs from "fs";
import { PDFParse } from "pdf-parse";

export default async function detectPdfType(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const data = await new PDFParse(buffer);

  if (data.text && data.text.trim().length > 200) {
    return "typed";
  }
  return "scanned";
}
