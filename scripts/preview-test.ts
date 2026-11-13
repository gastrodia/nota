import { spawn } from "node:child_process";
import { createMockModel } from "../tests/fixtures/mock-model";
const database =
  process.env.TEST_DATABASE_URL ??
  "postgresql://nota_test:nota_local_test_only@127.0.0.1:55437/nota_test";
const target = new URL(database);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.pathname !== "/nota_test"
)
  throw new Error(
    "Test preview only accepts the isolated local nota_test database.",
  );
const model = createMockModel();
model.listen(0, "127.0.0.1", () => {
  const address = model.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture start failed.");
  const child = spawn(
    "pnpm",
    ["start", "--hostname", "127.0.0.1", "--port", "3109"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: database,
        DASHSCOPE_API_KEY: "isolated-test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        BLOB_READ_WRITE_TOKEN: "",
        APP_URL: "http://127.0.0.1:3109",
        NOTA_TEST_MODE: "1",
        VERCEL: "",
        VERCEL_ENV: "",
      },
    },
  );
  console.log(
    "TEST PREVIEW: real local PostgreSQL; deterministic model fixture; cloud ASR and Blob disabled.",
  );
  const stop = () => {
    child.kill("SIGTERM");
    model.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => {
    model.close();
    process.exitCode = code ?? 0;
  });
});
