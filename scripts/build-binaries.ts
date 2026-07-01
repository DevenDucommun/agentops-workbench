// Compile standalone, zero-dependency `agentops` binaries for each supported
// platform via `bun build --compile`. Output lands in dist/. The release
// workflow uploads these as GitHub release assets; install.sh downloads them.
import { mkdirSync, rmSync } from "node:fs";

const targets = [
  { asset: "agentops-darwin-arm64", target: "bun-darwin-arm64" },
  { asset: "agentops-darwin-x64", target: "bun-darwin-x64" },
  { asset: "agentops-linux-x64", target: "bun-linux-x64" },
  { asset: "agentops-linux-arm64", target: "bun-linux-arm64" }
];

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

for (const { asset, target } of targets) {
  const outfile = `dist/${asset}`;
  const proc = Bun.spawnSync([
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    "./src/cli.ts",
    "--outfile",
    outfile
  ]);
  if (proc.exitCode !== 0) {
    process.stderr.write(proc.stderr.toString());
    process.stderr.write(`\nFailed to build ${asset} (${target}).\n`);
    process.exit(1);
  }
  console.log(`built ${outfile}`);
}

console.log(`\nDone. ${targets.length} binaries in dist/.`);
