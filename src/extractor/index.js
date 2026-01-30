import detectPdfType from "./detectPdfType.js";
import extractTypedPdf from "./extractTypedPdf.js";
import extractHandwrittenPdf from "./extractHandwrittenPdf.js";

export default async function extractPdf(pdfPath) {
  const type = await detectPdfType(pdfPath);

  if (type === "typed") {
    return await extractTypedPdf(pdfPath);
  } else {
    return await extractHandwrittenPdf(pdfPath);
  }
}
