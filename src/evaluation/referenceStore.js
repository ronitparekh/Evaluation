import fs from "fs";
import path from "path";

const DEFAULT_REFERENCE_PATH = path.resolve("data", "reference.json");

export function loadReferenceData(referencePath = DEFAULT_REFERENCE_PATH) {
  const sample = [
    {
      id: "sample-gs2-polity-1",
      subject: "GS2",
      domain: "polity",
      question:
        "Adequately empowering the third tier of Indian federal structure is key to strengthen federalism in India. Analyze.",
      answer_text:
        "Empowering local governments strengthens cooperative federalism through subsidiarity, citizen participation, and accountable service delivery. The 73rd and 74th Constitutional Amendments created panchayats and municipalities with constitutional status, regular elections, and devolution of functions. Effective fiscal decentralization, capacity building, and clear state finance commission recommendations are crucial to reduce dependency. Challenges include uneven devolution, political interference, and limited revenue powers. Strengthening planning, transparency, and local autonomy deepens democracy and improves governance outcomes.",
      type: "sample"
    }
  ];

  if (!fs.existsSync(referencePath)) {
    return sample;
  }

  const raw = fs.readFileSync(referencePath, "utf-8");
  if (!raw.trim()) {
    return sample;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed;
}
