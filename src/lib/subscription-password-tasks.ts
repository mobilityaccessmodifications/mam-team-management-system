export type SubscriptionPasswordTask = {
  taskId: string;
  subscriptionId: string;
  serviceName: string;
  dueOn: string;
  version: number;
};

export const SUBSCRIPTION_PASSWORD_LOAD_ERROR = "Subscription password tasks could not be loaded. Refresh and try again.";
export const SUBSCRIPTION_PASSWORD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSubscriptionPasswordTasks(data: unknown): SubscriptionPasswordTask[] {
  if (!Array.isArray(data)) throw new Error(SUBSCRIPTION_PASSWORD_LOAD_ERROR);
  const seen = new Set<string>();
  return data.map((value): SubscriptionPasswordTask => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(SUBSCRIPTION_PASSWORD_LOAD_ERROR);
    const row = value as Record<string, unknown>;
    if (typeof row.task_id !== "string" || !SUBSCRIPTION_PASSWORD_UUID.test(row.task_id) || seen.has(row.task_id)
      || typeof row.subscription_id !== "string" || !SUBSCRIPTION_PASSWORD_UUID.test(row.subscription_id)
      || typeof row.service_name !== "string" || !row.service_name.trim() || row.service_name.length > 160
      || typeof row.due_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.due_on)
      || !Number.isSafeInteger(row.version) || (row.version as number) < 1 || (row.version as number) >= Number.MAX_SAFE_INTEGER) {
      throw new Error(SUBSCRIPTION_PASSWORD_LOAD_ERROR);
    }
    const date = new Date(`${row.due_on}T12:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== row.due_on) throw new Error(SUBSCRIPTION_PASSWORD_LOAD_ERROR);
    seen.add(row.task_id);
    return { taskId: row.task_id, subscriptionId: row.subscription_id, serviceName: row.service_name, dueOn: row.due_on, version: row.version as number };
  }).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.serviceName.localeCompare(b.serviceName) || a.taskId.localeCompare(b.taskId));
}
