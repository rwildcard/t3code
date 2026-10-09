#!/usr/bin/env node
/**
 * Packages the Tauri desktop shell (apps/desktop-tauri) into an installer.
 *
 * The shell runs the same Node backend the Electron app does, so the package
 * carries a Node runtime beside the executable (a Tauri sidecar) and the
 * server tree as Tauri resources. On Windows the resource dir is the
 * executable's own directory:
 *
 *   T3 Code (Alpha).exe
 *   node.exe                 stock Node, copied from the build host
 *   server/bin.mjs           server bundle; the server finds client/,
 *   server/client/           resource-monitor/ and node_modules/ beside it
 *   server/resource-monitor/
 *   server/node_modules/     runtime externals, hoisted, no pnpm bookkeeping
 *   host/main.mjs            desktop host helper (apps/desktop-tauri/host), one file
 *
 * The window loads the same client/ embedded in the executable. Everything is
 * staged under apps/desktop-tauri/stage/<platform>-<arch> and handed to
 * `tauri build` as a --config override, so tauri.conf.json keeps working for
 * `tauri dev` without a stage.
 */
import * as NodeModule from "node:module";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import tauriPackageJson from "../apps/desktop-tauri/package.json" with { type: "json" };

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import {
  BuildArch,
  BuildPlatform,
  stageRuntimeExternals,
  stageWebClient,
} from "./build-cli-archive.ts";
import {
  countPayloadFiles,
  stageResourceMonitor,
  validateBundledClientAssets,
  verifyServerBundleDirectoryIsSelfContained,
} from "./build-desktop-artifact.ts";
import { resolveWebAssetBrandForPackageVersion } from "./lib/brand-assets.ts";

export class DesktopTauriBuildError extends Schema.TaggedError<DesktopTauriBuildError>()(
  "DesktopTauriBuildError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.step}: ${this.detail}`;
  }
}

interface TauriTarget {
  /** Rust triple; also the suffix Tauri expects on sidecar binaries. */
  readonly rustTarget: string;
  readonly bundles: ReadonlyArray<{ readonly name: string; readonly artifactSuffix: string }>;
}

// Tauri bundles for the host only, so each row needs a matching CI runner.
// Other platforms also need signing before they are worth a row here.
const TAURI_TARGETS: Partial<Record<`${BuildPlatform}-${BuildArch}`, TauriTarget>> = {
  "win-x64": {
    rustTarget: "x86_64-pc-windows-msvc",
    bundles: [{ name: "nsis", artifactSuffix: "-setup.exe" }],
  },
};

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { ...options, stdout: "inherit", stderr: "inherit" }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new DesktopTauriBuildError({
      step: label,
      detail: `exited with code ${String(exitCode)}.`,
    });
  }
});

/** The server bundle without its sourcemaps, which nothing in the package reads. */
const stageServerBundle = Effect.fn("stageServerBundle")(function* (
  serverDist: string,
  serverStageDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of yield* fs.readDirectory(serverDist)) {
    const source = path.join(serverDist, entry);
    if (entry === "client") {
      yield* stageWebClient(source, path.join(serverStageDir, "client"));
      continue;
    }
    const info = yield* fs.stat(source);
    if (info.type === "File" && !entry.endsWith(".map")) {
      yield* fs.copyFile(source, path.join(serverStageDir, entry));
    }
  }
});

function resolveTauriCli(appDir: string, path: Path.Path): string {
  const require = NodeModule.createRequire(path.join(appDir, "package.json"));
  return path.join(path.dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
}

const buildDesktopTauriArtifact = Effect.fn("buildDesktopTauriArtifact")(function* (input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly outputDir: string;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const targetKey = `${input.platform}-${input.arch}` as const;
  const target = TAURI_TARGETS[targetKey];
  if (target === undefined) {
    return yield* new DesktopTauriBuildError({
      step: "resolve target",
      detail: `${targetKey} is not packaged yet; add it to TAURI_TARGETS.`,
    });
  }
  const hostPlatform = yield* HostProcessPlatform;
  const hostBuildPlatform =
    hostPlatform === "win32" ? "win" : hostPlatform === "darwin" ? "mac" : "linux";
  if (hostBuildPlatform !== input.platform) {
    return yield* new DesktopTauriBuildError({
      step: "resolve target",
      detail: `Tauri bundles for the build host; run the ${input.platform} build on a ${input.platform} machine.`,
    });
  }

  const appDir = path.join(repoRoot, "apps/desktop-tauri");
  const tauriDir = path.join(appDir, "src-tauri");
  const stageDir = path.join(appDir, "stage", targetKey);
  const serverStageDir = path.join(stageDir, "server");
  const hostStageDir = path.join(stageDir, "host");
  const clientDir = path.join(serverStageDir, "client");
  const version = tauriPackageJson.version;

  yield* Effect.log("[desktop-tauri] Building the server bundle and web client...");
  const serverBuild = yield* resolveSpawnCommand("vp", ["run", "--filter", "t3", "build"]);
  yield* runCommand(
    serverBuild.command,
    serverBuild.args,
    {
      cwd: repoRoot,
      shell: serverBuild.shell,
      // The bridge hands the client its backend origin at runtime; a URL baked
      // into the bundle would pin every window to it. apps/web/vite.config.ts
      // merges .env underneath the process env, so an empty value is the only
      // way to clear one a developer keeps there.
      env: { ...process.env, VITE_HTTP_URL: "", VITE_WS_URL: "" },
    },
    "vp run --filter t3 build",
  );

  yield* Effect.log("[desktop-tauri] Building the bridge script and the desktop host...");
  const packBuild = yield* resolveSpawnCommand("vp", ["pack"]);
  yield* runCommand(
    packBuild.command,
    packBuild.args,
    { cwd: appDir, shell: packBuild.shell },
    "vp pack (bridge, host)",
  );

  yield* Effect.log(`[desktop-tauri] Staging ${targetKey} in ${stageDir}...`);
  yield* fs.remove(stageDir, { recursive: true, force: true });
  yield* fs.makeDirectory(serverStageDir, { recursive: true });
  yield* stageServerBundle(path.join(repoRoot, "apps/server/dist"), serverStageDir);
  if (!(yield* fs.exists(path.join(clientDir, "index.html")))) {
    return yield* new DesktopTauriBuildError({
      step: "stage client",
      detail: `apps/server/dist/client is missing; the web build did not run.`,
    });
  }
  // The server build applies development icons; the package gets the brand
  // of its release channel, like the Electron build.
  yield* applyWebBrandAssets(
    resolveWebAssetBrandForPackageVersion(version),
    path.relative(repoRoot, clientDir),
  );
  yield* validateBundledClientAssets(clientDir);
  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir: serverStageDir,
    platform: input.platform,
    arch: input.arch,
    verbose: input.verbose,
  });
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir: serverStageDir,
    platform: input.platform,
    arch: input.arch,
    version,
  });

  // Tauri strips the triple when it places the sidecar beside the executable.
  const stagedNode = path.join(
    stageDir,
    `node-${target.rustTarget}${input.platform === "win" ? ".exe" : ""}`,
  );
  yield* fs.copyFile(process.execPath, stagedNode);
  yield* Effect.log(`[desktop-tauri] Bundled Node ${process.version} from ${process.execPath}.`);

  yield* verifyServerBundleDirectoryIsSelfContained({
    bundleDir: serverStageDir,
    entryRelativePath: "bin.mjs",
    node: stagedNode,
    verbose: input.verbose,
  });
  yield* Effect.log("[desktop-tauri] Staged server runs without the repo (bin.mjs --version).");

  yield* fs.makeDirectory(hostStageDir, { recursive: true });
  yield* fs.copyFile(path.join(appDir, "dist/host/main.mjs"), path.join(hostStageDir, "main.mjs"));
  yield* verifyServerBundleDirectoryIsSelfContained({
    bundleDir: hostStageDir,
    entryRelativePath: "main.mjs",
    node: stagedNode,
    verbose: input.verbose,
  });
  yield* Effect.log(
    "[desktop-tauri] Staged desktop host runs without the repo (host/main.mjs --version).",
  );
  const fileCount = yield* countPayloadFiles(stageDir);
  yield* Effect.log(`[desktop-tauri] Staged ${String(fileCount)} files.`);

  // Paths in the config are relative to src-tauri. Tauri drops the drive
  // prefix from absolute paths, so relative is the only portable form.
  const fromTauriDir = (target: string) =>
    path.relative(tauriDir, target).split(path.sep).join("/");
  const config = {
    build: { frontendDist: fromTauriDir(clientDir) },
    bundle: {
      resources: {
        [fromTauriDir(serverStageDir)]: "server",
        [fromTauriDir(hostStageDir)]: "host",
      },
      externalBin: [fromTauriDir(path.join(stageDir, "node"))],
    },
  };
  yield* Effect.log("[desktop-tauri] Running tauri build...");
  yield* runCommand(
    process.execPath,
    [
      resolveTauriCli(appDir, path),
      "build",
      "--bundles",
      target.bundles.map((bundle) => bundle.name).join(","),
      "--config",
      yield* encodeJsonString(config),
    ],
    { cwd: appDir },
    "tauri build",
  );

  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const artifacts: string[] = [];
  for (const bundle of target.bundles) {
    const bundleDir = path.join(tauriDir, "target/release/bundle", bundle.name);
    for (const entry of yield* fs.readDirectory(bundleDir)) {
      if (!entry.endsWith(bundle.artifactSuffix)) continue;
      const artifactPath = path.join(input.outputDir, entry);
      yield* fs.copyFile(path.join(bundleDir, entry), artifactPath);
      const stat = yield* fs.stat(artifactPath);
      yield* Effect.log(`[desktop-tauri] Wrote ${artifactPath} (${String(stat.size)} bytes).`);
      artifacts.push(artifactPath);
    }
  }
  if (artifacts.length === 0) {
    return yield* new DesktopTauriBuildError({
      step: "collect artifacts",
      detail: `tauri build produced nothing under ${path.join(tauriDir, "target/release/bundle")}.`,
    });
  }
  return artifacts;
});

const command = Command.make(
  "build-desktop-tauri-artifact",
  {
    platform: Flag.Literals("platform", BuildPlatform.literals),
    arch: Flag.Literals("arch", BuildArch.literals),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("release")),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (input) => buildDesktopTauriArtifact(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Package the Tauri desktop shell into an installer."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
