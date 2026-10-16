import test from "node:test";
import assert from "node:assert/strict";
import { checkPackage } from "./check-package-contents.mjs";

const good = () => ({
  manifest: {
    name: "@docslurp/sdk", version: "0.3.0", license: "MIT", homepage: "https://docslurp.io/docs/packages/sdk",
    repository: { type: "git", url: "git+https://github.com/DocSlurp/docslurp-oss.git", directory: "packages/sdk" },
    bugs: { url: "https://github.com/DocSlurp/docslurp-oss/issues" }, publishConfig: { access: "public" },
    main: "dist/index.js", exports: { ".": { import: "./dist/index.js" } }, dependencies: { a: "^1.0.0" },
  },
  files: new Set(["package.json", "LICENSE", "README.md", "dist/index.js"]),
  readme: "# @docslurp/sdk\n\n[Package docs](https://docslurp.io/docs/packages/sdk) · [GitHub](https://github.com/x) · [npm](https://npmjs.com/x)\n",
  license: "MIT License",
});

test("accepts a well-formed package", () => assert.deepEqual(checkPackage(good()), []));
test("rejects workspace specifiers, missing targets and shipped sources", () => {
  const input = good();
  input.manifest.dependencies = { a: "workspace:^" };
  input.files.add("src/index.ts");
  input.files.delete("dist/index.js");
  const problems = checkPackage(input).join("\n");
  assert.match(problems, /workspace:/);
  assert.match(problems, /not in the tarball/);
  assert.match(problems, /must not ship: src\/index\.ts/);
});
test("rejects wrong licence and README", () => {
  const input = good();
  input.manifest.license = "Apache-2.0";
  input.readme = "# other\n";
  assert.equal(checkPackage(input).length, 2);
});
