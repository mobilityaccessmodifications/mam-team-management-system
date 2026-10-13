export type TaskNotesTarget = {
  kind: "check_in" | "subscription_review" | "work_schedule";
  taskId: string;
  reviewOn?: string;
};

export type TaskNotes = {
  text: string;
  version: number;
};

export const MAX_TASK_NOTES_LENGTH = 5_000;
