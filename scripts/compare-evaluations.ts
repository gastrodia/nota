import { readFile } from "node:fs/promises";
import { compareReports, type EvaluationReport } from "./lib/evaluation";

async function main() {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath)
    throw new Error(
      "Usage: tsx scripts/compare-evaluations.ts baseline.json candidate.json",
    );
  const [baseline, candidate] = await Promise.all(
    [baselinePath, candidatePath].map(
      async (path) =>
        JSON.parse(await readFile(path, "utf8")) as EvaluationReport,
    ),
  );
  const comparison = compareReports(baseline, candidate);
  console.log(JSON.stringify(comparison, null, 2));
  if (comparison.has_regression) process.exitCode = 1;
}
main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Could not compare evaluation reports.",
  );
  process.exitCode = 1;
});
