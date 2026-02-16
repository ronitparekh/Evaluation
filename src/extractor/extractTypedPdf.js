import { PDFExtract } from "pdf.js-extract";

export default async function extractTypedPdf(pdfPath) {
  const pdfExtract = new PDFExtract();
  const data = await pdfExtract.extract(pdfPath);

  let text = "";
  for (const page of data.pages) {
    for (const content of page.content) {
      if (content.str) {
        text += content.str + " ";
      }
    }
    text += "\n";
  }

  return text
    .replace(/\n{2,}/g, "\n")
    .replace(/ +/g, " ")
    .trim();
}
