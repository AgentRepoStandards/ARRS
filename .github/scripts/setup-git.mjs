import { createHash } from "node:crypto";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

// Upstream v2.52.0 signed tag resolves this immutable Git source commit.
// Archive SHA-256 was independently downloaded and recorded during preparation.
const linux = {
  platform: "linux",
  url: "https://codeload.github.com/git/git/tar.gz/9a2fb147f2c61d0cab52c883e7e26f5b7948e3ed",
  sha256: "8b10342a49e19a02c2bcd32d77bde33d5ce88318b6d91c5dee5d7c85fcddb038",
  archive: "git-source.tar.gz",
  source: "git-9a2fb147f2c61d0cab52c883e7e26f5b7948e3ed",
  version: "git version 2.52.0",
};
// Official immutable Git-for-Windows release: asset digest and release table agree.
const windows = {
  platform: "win32",
  url: "https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/MinGit-2.52.0-64-bit.zip",
  sha256: "f42a561840627747ad48e6ece05a14093292d31f3393a401a7f7c780ee7695c2",
  archive: "mingit.zip",
  version: "git version 2.52.0.windows.1",
};

async function download(url) {
  const signal = AbortSignal.timeout(120_000);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password)
      throw new Error("Git downloads require an HTTPS URL without credentials");
    response = await fetch(target, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirects === 5)
      throw new Error("Git download exceeds its HTTPS redirect bound");
    await response.body?.cancel();
    url = new URL(location, target).href;
  }
  if (!response.ok) throw new Error(`Git download failed: HTTP ${response.status}`);
  if (new URL(response.url).protocol !== "https:")
    throw new Error("Git download redirected outside HTTPS");
  const limit = 100_000_000;
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("Git download exceeds the 100 MB archive bound");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Git download exceeds the 100 MB archive bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Dependency injection is used by offline failure-contract tests. The CI entry
// point below selects only the fixed official artifact; it accepts no URL/hash override.
export async function provisionGit({
  platform = process.platform,
  arch = process.arch,
  artifact = platform === "linux" ? linux : windows,
  runnerTemp = process.env.RUNNER_TEMP,
  pathFile = process.env.GITHUB_PATH,
  downloadArchive = download,
  run = spawnSync,
} = {}) {
  if (!["linux", "win32"].includes(platform) || arch !== "x64")
    throw new Error(`Unsupported hosted Git platform ${platform}/${arch}`);
  if (!runnerTemp || !pathFile)
    throw new Error("Hosted Git setup requires RUNNER_TEMP and GITHUB_PATH");
  if (artifact.platform !== platform)
    throw new Error("Git artifact platform does not match the selected runner");
  const payload = await downloadArchive(artifact.url);
  const actual = createHash("sha256").update(payload).digest("hex");
  if (actual !== artifact.sha256)
    throw new Error(
      `Git archive SHA-256 mismatch: expected ${artifact.sha256}; got ${actual}`,
    );

  // No downloaded bytes are extracted or executed until their fixed digest passes.
  const work = await mkdtemp(join(resolve(runnerTemp), "arrs-git-2.52-"));
  const archive = join(work, artifact.archive);
  const install = join(work, "install");
  await writeFile(archive, payload, { flag: "wx" });
  const invoke = (file, args, options = {}) => {
    const result = run(file, args, {
      stdio: "inherit",
      timeout: 600_000,
      ...options,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Git setup command ${file} failed (${result.status ?? result.error?.code})`,
      );
    return result;
  };

  let bin;
  if (platform === "linux") {
    invoke("sudo", ["apt-get", "update"]);
    invoke("sudo", [
      "apt-get",
      "install",
      "--no-install-recommends",
      "--yes",
      "build-essential",
      "libcurl4-openssl-dev",
      "libexpat1-dev",
      "gettext",
      "zlib1g-dev",
    ]);
    invoke("tar", ["-xzf", archive, "-C", work]);
    const cwd = join(work, artifact.source);
    const configuration = [`prefix=${install}`, "NO_TCLTK=YesPlease"];
    invoke("make", ["-j2", ...configuration, "all"], { cwd });
    invoke("make", [...configuration, "install"], { cwd });
    bin = join(install, "bin");
  } else {
    invoke(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:ARRS_GIT_ARCHIVE -DestinationPath $env:ARRS_GIT_INSTALL",
      ],
      {
        env: {
          ...process.env,
          ARRS_GIT_ARCHIVE: archive,
          ARRS_GIT_INSTALL: install,
        },
      },
    );
    bin = join(install, "cmd");
  }

  const git = join(bin, platform === "win32" ? "git.exe" : "git");
  const version = invoke(git, ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
  }).stdout.trim();
  if (version !== artifact.version)
    throw new Error(
      `Installed Git version mismatch: expected ${artifact.version}; got ${version}`,
    );
  // Check PATH resolution before publishing it to subsequent Actions steps.
  const commandPath = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  const commandEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  commandEnv.PATH = commandPath;
  const resolvedVersion = invoke("git", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    env: commandEnv,
  }).stdout.trim();
  if (resolvedVersion !== artifact.version)
    throw new Error(`PATH resolves unsupported Git: ${resolvedVersion}`);
  // remote-ext is a compiled-in Git command; it need not have its own .exe.
  // This no-argument invocation must reach that command's native usage handler.
  const remoteExt = run(git, ["remote-ext"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  });
  if (
    remoteExt.error ||
    remoteExt.status !== 129 ||
    !String(remoteExt.stderr).includes("git remote-ext <remote> <url>")
  )
    throw new Error("Pinned Git lacks the required native remote-ext helper");
  const shell = platform === "win32" ? join(install, "usr", "bin", "sh.exe") : "/bin/sh";
  invoke(shell, ["-c", "exit 0"], { timeout: 30_000 });
  await appendFile(pathFile, `${bin}\n`, "utf8");
  console.log(`Provisioned ${version}`);
  return { git, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await provisionGit();
