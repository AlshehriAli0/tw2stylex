/**
 * Packs packages/tw2sx with the root README and LICENSE carried in.
 *
 * npm ships only what sits in the package directory, and neither file lives there: keeping a
 * second copy under packages/ would drift from the one people read on GitHub. So they are copied
 * for the pack and removed afterwards, on the failure path too.
 *
 * This is a script rather than a prepack hook because npm skips lifecycle scripts when
 * ignore-scripts is configured, and the result is a tarball with no README and no way to tell.
 */
import { rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = path.join(root, "packages/tw2sx");
const RAW = "https://raw.githubusercontent.com/AlshehriAli0/tailwind-2-stylex/main/";

// The repo README points at assets/ relatively so GitHub renders it. npm resolves nothing, so
// the published copy needs the absolute URL.
const readmeForNpm = (): string =>
  readFileSync(path.join(root, "README.md"), "utf8").replaceAll(
    'src="assets/',
    `src="${RAW}assets/`,
  );

const carried = ["README.md", "LICENSE"].map(f => path.join(pkg, f));

const clean = (): void => {
  for (const file of carried) rmSync(file, { force: true });
};

try {
  writeFileSync(path.join(pkg, "README.md"), readmeForNpm());
  copyFileSync(path.join(root, "LICENSE"), path.join(pkg, "LICENSE"));
  Bun.spawnSync(["bun", "run", "build"], { cwd: pkg, stdio: ["inherit", "inherit", "inherit"] });
  const packed = Bun.spawnSync(["npm", "pack", "--pack-destination", root], {
    cwd: pkg,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (packed.exitCode !== 0) process.exit(packed.exitCode ?? 1);
} finally {
  clean();
}
