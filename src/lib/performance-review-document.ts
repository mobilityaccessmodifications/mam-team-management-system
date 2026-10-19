import { buildReviewDocx } from "./performance-review-word.mjs";
import { QUESTIONS } from "./performance-review-questions.mjs";
import type { PerformanceDocument } from "./performance-review-types";

export function buildPerformanceReviewDownload(document: PerformanceDocument) {
  if (!["employee", "manager", "admin"].includes(document.audience) || !/^PR-\d{4}-\d+$/.test(document.code)) {
    throw new Error("The review document is invalid.");
  }
  return {
    bytes: buildReviewDocx(document, QUESTIONS[document.employee.company]),
    fileName: `${document.code}-${document.audience === "employee" ? "employee" : "manager"}.docx`,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}
