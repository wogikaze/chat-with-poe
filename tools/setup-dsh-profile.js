import { promisify } from "node:util";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config();

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeEntry = process.env.DSH_BIN || path.join(projectRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const dshBin = process.env.DSH_CLI || process.execPath;
const profile = process.env.DSH_PROFILE || "poe";
const dshHome = process.env.DSH_HOME?.replace(/^~(?=$|\/)/, process.env.HOME || "")
    || path.join(process.env.HOME || "", ".dsh");
const profileManifest = path.join(dshHome, "profiles", profile, "package.json");

if (!path.isAbsolute(dshBin)) throw new Error("DSH_CLI must be an absolute path to the DeepSeek Harness launcher.");

async function enableGemini4ThinkingLevel() {
    // pi-ai has import-only exports; require.resolve(package) cannot resolve it.
    // Search relative to the selected runtime so nested and hoisted installs work.
    const piAiPath = (createRequire(runtimeEntry).resolve.paths("@earendil-works/pi-ai") || [])
        .map(directory => path.join(directory, "@earendil-works", "pi-ai", "dist", "api", "google-shared.js"))
        .find(filename => existsSync(filename));
    if (!piAiPath) throw new Error("The selected DSH runtime has no pi-ai Vertex adapter.");
    let source = await readFile(piAiPath, "utf8");
    if (source.includes("/gemini-4-argon/.test(id)")) return;
    const catalogPattern = String.raw`/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||`;
    if (!source.includes(catalogPattern)) {
        throw new Error(`Could not add Gemini 4 Argon thinking-level support to ${piAiPath}; the installed pi-ai source changed.`);
    }
    source = source.replace(catalogPattern, `${catalogPattern}\n        /gemini-4-argon/.test(id) ||`);
    await writeFile(piAiPath, source);
    console.log("Enabled Gemini 4 Argon thinking-level requests in the installed Vertex adapter.");
}

async function run(args, { printStdout = true } = {}) {
    const { stdout, stderr } = await execFileAsync(dshBin, process.env.DSH_CLI ? args : [runtimeEntry, ...args], {
        env: { ...process.env, DSH_HOME: dshHome },
        timeout: 5 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
    });
    if (stderr.trim()) process.stderr.write(stderr);
    if (printStdout && stdout.trim()) process.stdout.write(stdout);
}

let manifest;
try { manifest = JSON.parse(await readFile(profileManifest, "utf8")); }
catch (error) {
    if (error.code !== "ENOENT") throw error;
}
if (!manifest) {
    console.log(`Preparing the ${profile} profile from the shipped SDK profile...`);
    await run(["--profile", profile, "--from-default-profile", "sdk", "--dump-config"], { printStdout: false });
    manifest = JSON.parse(await readFile(profileManifest, "utf8"));
}

await enableGemini4ThinkingLevel();

console.log("Checking the composed profile and memory overlay...");
await run(["--profile", profile, "--patch", new URL("../dsh/poe.patch.yml", import.meta.url).pathname, "--dump-config"], { printStdout: false });
console.log("DeepSeek Harness profile setup complete.");
