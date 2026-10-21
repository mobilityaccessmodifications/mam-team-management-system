import { createHash } from 'node:crypto';
import { buildReviewDocx } from '../src/lib/performance-review-word.mjs';
import { QUESTIONS } from '../src/lib/performance-review-questions.mjs';

export function payload() {
  const doc = {
    audience: 'manager', code: 'PR-2026-900001', cycle: 'Synthetic period',
    employee: {company: 'MAM', name: 'Synthetic <Employee>', jobTitle: 'Synthetic role', team: 'Synthetic team'},
    manager: {name: 'Synthetic & Manager'},
    selfAnswers: Array(12).fill('Synthetic employee answer'), managerAnswers: Array(12).fill('Synthetic manager answer'),
    ratings: Array(12).fill('2'), summary: 'Synthetic summary', overallRating: '2',
    meeting: {date: '2026-10-15', time: '10:00', duration: 30, mode: 'In person', location: 'Synthetic room', notes: 'Synthetic meeting'},
  };
  const bytes = Buffer.from(buildReviewDocx(doc, QUESTIONS.MAM));
  const reviewId = '730f0100-0000-4000-8000-000000000002';
  return {
    version: 1, event: 'performance-review-finalised', eventKey: `performance-review:${reviewId}:finalised`,
    deliveryId: '730f0100-0000-4000-8000-000000000001', reviewId, reviewCode: doc.code,
    claimToken: '730f0100-0000-4000-8000-000000000003', employeeName: doc.employee.name, managerName: doc.manager.name,
    finalisedAt: '2026-10-16T00:00:00.000Z', recipient: 'manager@mobilityaccess.com.au',
    managerNote: 'PRIVATE-SYNTHETIC-NOTE <script>"&\'\nsecond line',
    attachment: {fileName: `${doc.code}-manager.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex')},
  };
}
