export function previewTask(title) {
  const normalized = title.trim();
  if (!normalized) throw new Error("Task title is required");
  return { title: normalized, state: "queued" };
}
