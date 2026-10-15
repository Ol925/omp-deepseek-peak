// 发布前检查：node tools/preflight.mjs
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// 1) package.json 必须是合法 JSON，且带 omp.extensions 清单
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
} catch (error) {
  console.error(`✘ package.json 不是合法 JSON：${error.message}`);
  process.exit(1);
}

if (!pkg.omp?.extensions?.length) {
  problems.push("package.json 缺少 omp.extensions 清单 — omp 无法识别这个包里的扩展");
}
if (pkg.name !== "omp-deepseek-peak") problems.push(`name 是 ${pkg.name}`);
if (!pkg.version) problems.push("缺少 version（omp plugin upgrade 靠它判断新版）");
if (pkg.license !== "MIT") problems.push(`license 是 ${pkg.license}`);
if (Object.keys(pkg.dependencies ?? {}).length > 0) {
  problems.push("dependencies 非空 — 本扩展运行时应该零依赖");
}
if (!existsSync(join(ROOT, "LICENSE"))) problems.push("缺少 LICENSE 文件");

// 2) files 白名单里列的东西必须真的存在
for (const file of pkg.files ?? []) {
  if (!existsSync(join(ROOT, file))) problems.push(`files 里列的 ${file} 不存在`);
}

// 3) 运行时文件齐不齐
for (const file of pkg.omp?.extensions ?? []) {
  const target = join(ROOT, file.replace(/^\.\//, ""));
  if (!existsSync(target)) problems.push(`omp.extensions 指向的 ${file} 不存在`);
}

// 4) node_modules 不能被 .gitignore 漏掉（否则会提交 832 MB）
const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
if (!/^node_modules\/?$/m.test(gitignore)) {
  problems.push(".gitignore 没有忽略 node_modules — 会把依赖一起提交");
}

// 5) holidays.ts 必须被提交（生成物但不能忽略）
if (/^holidays\.ts$/m.test(gitignore)) {
  problems.push(".gitignore 忽略了 holidays.ts — 它是生成物但必须提交");
}
if (!existsSync(join(ROOT, "holidays.ts"))) problems.push("holidays.ts 不存在");

// 6) 占位符
const PLACEHOLDERS = ["YOUR_GITHUB_USERNAME", "YOUR NAME"];
const found = [];
for (const file of ["package.json", "README.md", "LICENSE"]) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const token of PLACEHOLDERS) {
    const count = text.split(token).length - 1;
    if (count > 0) found.push(`${file}: ${token} × ${count}`);
  }
}

console.log(`包名      ${pkg.name}@${pkg.version}`);
console.log(`清单      omp.extensions = [${(pkg.omp?.extensions ?? []).join(", ")}]`);
console.log(`许可      ${pkg.license}`);
console.log(`运行时依赖 ${Object.keys(pkg.dependencies ?? {}).length} 个`);
console.log("");

if (found.length > 0) {
  console.log("待替换的占位符：");
  for (const item of found) console.log(`  · ${item}`);
  console.log("");
}

if (problems.length === 0) {
  console.log("✓ 发布前检查通过");
  process.exitCode = 0;
} else {
  for (const problem of problems) console.error(`✘ ${problem}`);
  process.exitCode = 1;
}
