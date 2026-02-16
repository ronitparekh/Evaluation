import { PDFExtract } from "pdf.js-extract";

export default async function detectPdfType(pdfPath) {
  const pdfExtract = new PDFExtract();
  const data = await pdfExtract.extract(pdfPath);

  let textLength = 0;
  for (const page of data.pages) {
    for (const content of page.content) {
      if (content.str) {
        textLength += content.str.length;
      }
    }
  }

  if (textLength > 200) {
    return "typed";
  }
  return "scanned";
}
