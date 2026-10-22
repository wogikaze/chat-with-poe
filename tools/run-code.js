import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

// Images are fixed by the bot; user/model input is mounted only as one source file.
const GCC = "gcc:14.2-bookworm@sha256:b99b86a28812b1e6453a231a947dc43d76fe192788a12f344a9b568bf9f5d24c";
const PYTHON = "python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641";

export const RUNNERS = Object.freeze({
    c:           { label: "C",          image: GCC,                       file: "main.c",      command: "gcc -std=c17 -O2 /main.c -o /tmp/program && /tmp/program" },
    cpp:         { label: "C++",        image: GCC,                       file: "main.cpp",    command: "g++ -std=c++20 -O2 /main.cpp -o /tmp/program && /tmp/program" },
    python:      { label: "Python",     image: PYTHON,                     file: "main.py",      command: "python -B -I /main.py" },
    javascript:  { label: "JavaScript", image: "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392", file: "main.js", command: "node --disable-proto=throw /main.js" },
    typescript:  { label: "TypeScript", image: "denoland/deno:2.5.6@sha256:3ea71953ff50e3ff15c377ead1a8521f624e2f43d27713675a8bed7b33f166aa", file: "main.ts", command: "deno run --no-prompt --cached-only /main.ts" },
    java:        { label: "Java",       image: "eclipse-temurin:21-jdk@sha256:f9bf7e9fe2f9bc4657537c1a7e20c768f0c3bafca41598263be4714783dd62eb", file: "Main.java", command: "mkdir -p /tmp/classes && javac -d /tmp/classes /Main.java && java -Djava.io.tmpdir=/tmp -cp /tmp/classes Main" },
    go:          { label: "Go",         image: "golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437", file: "main.go", command: "cd /tmp && go run /main.go" },
    rust:        { label: "Rust",       image: "rust:1.90-slim-bookworm@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9", file: "main.rs", command: "rustc -O /main.rs -o /tmp/program && /tmp/program" },
    ruby:        { label: "Ruby",       image: "ruby:3.4-slim-bookworm@sha256:22165c5f904d76a8a02fbdd419d0269481369523fd66978232d16c88099730e2", file: "main.rb", command: "ruby --disable-gems /main.rb" },
    php:         { label: "PHP",        image: "php:8.4-cli-bookworm@sha256:836ac6c672d1372a47c8fd61b625015bd07760f493fb2eaab2087636498a2b4b", file: "main.php", command: "php -n /main.php" },
    csharp:      { label: "C#",         image: "mcr.microsoft.com/dotnet/sdk:8.0@sha256:f7e28a0a3f6f9235929ec19274fd0ddf8534e9159f99fac602ac73304f1ce99f", file: "Program.cs", command: "mkdir -p /tmp/app && printf 'global using System;\\n' > /tmp/app/Program.cs && cat /Program.cs >> /tmp/app/Program.cs && refs=$(printf ' -r:%s' /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/8.0.32/ref/net8.0/*.dll) && dotnet exec /usr/share/dotnet/sdk/8.0.426/Roslyn/bincore/csc.dll -noconfig -nostdlib+ -out:/tmp/app/App.dll $refs tmp/app/Program.cs && printf '%s\\n' '{\"runtimeOptions\":{\"tfm\":\"net8.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"8.0.0\"}}}' > /tmp/app/App.runtimeconfig.json && dotnet /tmp/app/App.dll" },
    bash:        { label: "Bash",       image: "bash:5.2@sha256:a54fb4422b18f05dd3107c36f39d67b26334fda7ec89f4126052b45e228e2f15", file: "main.sh", command: "bash --noprofile --norc /main.sh" },
    swift:       { label: "Swift",      image: "swift:6.2@sha256:eccc7a97f9b9881d9659e2e788081fd7675f86d39793b51200bfb178398b3784", file: "main.swift", command: "swift /main.swift" },
    kotlin:      { label: "Kotlin",     image: "gmazzo/kotlin:2.4.0-eclipse-temurin-21@sha256:e498cca00a959563fad2a7c50dd15b0a601d56df647be815c5ab468260c1028a", file: "Main.kt", command: "kotlinc /Main.kt -include-runtime -d /tmp/program.jar && java -Djava.io.tmpdir=/tmp -jar /tmp/program.jar" },
    perl:        { label: "Perl",       image: "perl:5.42-slim@sha256:ae140b241337000207acd7da4676bb10e5d31865c5901d0f3b091d5df4775ab4", file: "main.pl", command: "perl /main.pl" },
    r:           { label: "R",          image: "r-base:4.5.2@sha256:c84d2d97cb9c4d895b219d83a5fd480302a6ad0d2fd449f3cda7978583909a02", file: "main.R", command: "Rscript --vanilla /main.R" },
    lua:         { label: "Lua",        image: "nickblah/lua:5.4-debian@sha256:42e801f11377fce163a243e721d867b46f08f54efd4ff736ba1d969e4636a8ca", file: "main.lua", command: "lua /main.lua" },
    haskell:     { label: "Haskell",    image: "haskell:9.10@sha256:365e1baa8ddcde41b5187c3b9b4254c876fe397330b494b71cec48922ce99310", file: "Main.hs", command: "mkdir -p /tmp/ghc && ghc -v0 -outputdir /tmp/ghc -o /tmp/program /Main.hs && /tmp/program" },
    scala:       { label: "Scala",      image: "sbtscala/scala-sbt:eclipse-temurin-21.0.7_6_1.11.2_2.13.16@sha256:23f43c1146b645a06390a102b768b9058c01291a67e821e59150c804d3747fa9", file: "Main.scala", command: "scala /Main.scala" },
    sql:         { label: "SQL (SQLite)", image: PYTHON,                    file: "main.sql",     command: "python -I -c 'import sqlite3; db=sqlite3.connect(\":memory:\"); [print(row) for stmt in open(\"/main.sql\").read().split(\";\") if stmt.strip() for cur in [db.execute(stmt)] if cur.description for row in cur.fetchall()]'" },
});

const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_OUTPUT_CHARS = 8000;
const MAX_ACTIVE_JOBS = 2;
const MAX_QUEUED_JOBS = 8;
let activeJobs = 0;
const jobQueue = [];

function limited(value) {
    const text = String(value || "");
    return text.length > MAX_OUTPUT_CHARS
        ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[出力を省略しました]`
        : text;
}

async function withJobSlot(task) {
    if (activeJobs >= MAX_ACTIVE_JOBS) {
        if (jobQueue.length >= MAX_QUEUED_JOBS) return { ok: false, error: "実行待ちが多いため、少し待ってから再度お試しください。" };
        await new Promise(resolve => jobQueue.push(resolve));
    } else {
        activeJobs++;
    }

    try {
        return await task();
    } finally {
        const next = jobQueue.shift();
        if (next) next();
        else activeJobs--;
    }
}

export async function runCode(language, source) {
    const runner = RUNNERS[language];
    if (!runner) return { ok: false, error: "未対応の言語です。" };
    if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
        return { ok: false, error: `ソースコードは${MAX_SOURCE_BYTES} bytes以下で指定してください。` };
    }

    return withJobSlot(async () => {
        const workdir = await mkdtemp(join(tmpdir(), "chat-poe-code-"));
        const sourceDir = join(workdir, "src");
        const sourcePath = join(sourceDir, runner.file);
        const containerName = `chat-poe-code-${randomUUID()}`;
        let created = false;

        try {
            // The sandbox runs as uid 65534. Make the bind-mounted path traversable
            // and the source readable by that uid; mkdtemp otherwise leaves the
            // parent at 0700, which prevents rustc (and other compilers) opening it.
            await chmod(workdir, 0o711);
            await mkdir(sourceDir, { mode: 0o755 });
            await writeFile(sourcePath, source, { encoding: "utf8", mode: 0o444 });
            // systemd starts this bot with UMask=0077, so writeFile's mode is
            // reduced to 0400 despite the requested 0444. The container runs
            // as uid 65534 and cannot read a host-user-owned 0400 bind mount.
            await chmod(sourcePath, 0o444);
            const args = [
                "run", "--name", containerName, "--rm", "--init",
                "--network", "none", "--read-only",
                "--memory=768m", "--memory-swap=768m", "--cpus=1", "--pids-limit=32",
                "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "65534:65534",
                "--ulimit", "cpu=20:20",
                "--ulimit", "nofile=1024:1024", "--ulimit", "core=0:0",
                "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777",
                "--mount", `type=bind,src=${sourcePath},dst=/${runner.file},readonly`,
                "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", "--env", "GOTOOLCHAIN=local",
                "--env", "GOCACHE=/tmp/gocache", "--env", "GOMODCACHE=/tmp/gomod",
                "--env", "DOTNET_CLI_HOME=/tmp/dotnet", "--env", "NUGET_PACKAGES=/tmp/nuget",
                "--env", "DOTNET_CLI_TELEMETRY_OPTOUT=1", "--env", "DOTNET_NOLOGO=1",
                "--env", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1",
                "--env", "COURSIER_CACHE=/tmp/coursier", "--env", "SCALA_CLI_HOME=/tmp/scala-cli",
                "--entrypoint", "/bin/sh", runner.image, "-euc",
                `ulimit -t 20; ${runner.command}`,
            ];
            created = true;
            const result = await execFileAsync("docker", args, {
                timeout: 45000,
                maxBuffer: 64 * 1024,
                windowsHide: true,
            });
            return { ok: true, language: runner.label, exitCode: 0, stdout: limited(result.stdout), stderr: limited(result.stderr) };
        } catch (err) {
            return {
                ok: false,
                language: runner.label,
                exitCode: Number.isInteger(err.code) ? err.code : null,
                timedOut: err.killed || err.code === "ETIMEDOUT",
                stdout: limited(err.stdout),
                stderr: limited(err.stderr || err.message),
            };
        } finally {
            if (created) {
                try { await execFileAsync("docker", ["rm", "--force", containerName], { timeout: 5000, maxBuffer: 4096 }); } catch {}
            }
            await rm(workdir, { recursive: true, force: true });
        }
    });
}
