import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
async function main() {
  const config = await mkdtemp(join(tmpdir(), "nota-docker-"));
  const name = `nota-test-${process.pid}`;
  let started = false;
  function run(args: string[], env = process.env) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("pnpm", args, { stdio: "inherit", env });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Command failed (${code})`)),
      );
    });
  }
  try {
    await writeFile(join(config, "config.json"), '{"auths":{}}');
    await exec("docker", [
      "--config",
      config,
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_USER=nota_test",
      "-e",
      "POSTGRES_PASSWORD=nota_local_test_only",
      "-e",
      "POSTGRES_DB=nota_test",
      "postgres:17-alpine",
    ]);
    started = true;
    const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
    const port = stdout.trim().split(":").at(-1);
    const url = `postgresql://nota_test:nota_local_test_only@127.0.0.1:${port}/nota_test`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        await exec("docker", ["exec", name, "pg_isready", "-U", "nota_test"]);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!ready) throw new Error("Test PostgreSQL did not start.");
    const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
    await run(["db:migrate"], env);
    await run(["test"], env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local test setup failed.",
    );
    process.exitCode = 1;
  } finally {
    if (started) await exec("docker", ["stop", name]).catch(() => {});
    await rm(config, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error("Local tests failed.");
  process.exitCode = 1;
});
