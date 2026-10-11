import { previewTask } from "../domain/task.mjs";
try {
  console.log(JSON.stringify(previewTask(process.argv[2] ?? "")));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
