// agent/run.js
import { runAgent } from "./agent.js";

const task = process.argv.slice(2).join(" ") || "计算 1+1 等于多少，然后告诉我答案";
const site = process.env.SITE || "deepseek";

runAgent(task, { site, maxSteps: 10 })
  .then(result => {
    console.log("\n=== 结果 ===");
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error("Agent 崩溃:", err);
    process.exit(1);
  });