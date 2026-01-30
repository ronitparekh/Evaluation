import fs from "fs";
import { PDFParse } from "pdf-parse";

export default async function extractTypedPdf(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const data = await new PDFParse(buffer);

  return data.text
    .replace(/\n{2,}/g, "\n")
    .replace(/ +/g, " ")
    .trim();
}
