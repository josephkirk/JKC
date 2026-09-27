import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargoTarget = path.join(projectRoot, "src-tauri", "target", "release");
const outputDir = path.join(projectRoot, "target", "release");
const executableName = process.platform === "win32" ? "jkc.exe" : "jkc";
const builtExecutable = path.join(cargoTarget, executableName);
const outputExecutable = path.join(outputDir, executableName);
const npmCommand = "npm";

async function cleanReleaseDatabases() {
  const candidates = [
    path.join(projectRoot, "jkc_data"),
    path.join(projectRoot, "target", "release", "jkc_data"),
    path.join(projectRoot, "src-tauri", "target", "release", "jkc_data"),
  ];
  for (const dir of candidates) {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(path.join(dir, `jkc.sqlite3${suffix}`), { force: true });
    }
  }
  console.log("Cleaned release database files.");
}

await cleanReleaseDatabases();
console.log("Building JKC release executable...");
execFileSync(npmCommand, ["run", "tauri", "build", "--", "--no-bundle"], {
  cwd: projectRoot,
  shell: true,
  stdio: "inherit",
});

await stat(builtExecutable);
await mkdir(outputDir, { recursive: true });
await cp(builtExecutable, outputExecutable);

console.log(`Release executable: ${path.relative(projectRoot, outputExecutable)}`);
