import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const binariesDir = path.join(appRoot, "src-tauri", "binaries");
const resourcesPromptsDir = path.join(appRoot, "src-tauri", "resources", "prompts");
const promptsSource = path.resolve(appRoot, "../prompts");

const bunTargetByTriple = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

function bunAvailable() {
  try {
    execSync("bun --version", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    });
    return true;
  } catch {
    return false;
  }
}

if (!bunAvailable()) {
  console.error(
    "bun is required to package the Pi agent sidecar.\n" +
      "Install from https://bun.sh then re-run the build.",
  );
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
const targetTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
  execSync("rustc --print host-tuple", {
    encoding: "utf8",
    shell: true,
  }).trim();

if (!targetTriple) {
  console.error("Could not determine Rust target triple");
  process.exit(1);
}

fs.mkdirSync(binariesDir, { recursive: true });
fs.mkdirSync(resourcesPromptsDir, { recursive: true });

for (const file of fs.readdirSync(promptsSource)) {
  if (!file.endsWith(".md")) continue;
  fs.copyFileSync(path.join(promptsSource, file), path.join(resourcesPromptsDir, file));
}

const outfile = path.join(binariesDir, `fieldnote-agent-${targetTriple}${ext}`);
const bunTarget = bunTargetByTriple[targetTriple];
const args = [
  "build",
  path.join(appRoot, "agent", "runner.ts"),
  "--compile",
  "--outfile",
  outfile,
];
if (bunTarget) {
  args.push("--target", bunTarget);
}

console.log(`Building agent sidecar → ${outfile}`);
const bunCmd = process.platform === "win32" ? "bun.cmd" : "bun";
const result = spawnSync(bunCmd, args, {
  cwd: appRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: true,
});

if (result.status !== 0) {
  console.error(`bun build failed with exit code ${result.status ?? "unknown"}`);
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(outfile)) {
  console.error(`Sidecar was not created at ${outfile}`);
  process.exit(1);
}

console.log("Agent sidecar ready.");
