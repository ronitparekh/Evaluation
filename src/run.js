import extractPdf from "./extractor/index.js";

const PDF_PATH = "uploads/sample4.pdf";

(async () => {
  console.log(`Processing: ${PDF_PATH}`);
  const text = await extractPdf(PDF_PATH);

  console.log("\n===== EXTRACTED TEXT =====\n");
  console.log(text);
})();
