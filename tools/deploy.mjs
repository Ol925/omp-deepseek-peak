// 把运行时文件部署到 omp 的用户级扩展目录。
//
//   npm run deploy     复制
//   npm run verify     只比对，不修改；不同步时以非零码退出
//
// 用 Node 而不是 PowerShell，因此不受脚本执行策略限制，且跨平台。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 真正被 omp 加载的文件；改动这个列表等于改动发布内容。 */
const RUNTIME_FILES = [
  "index.ts",
  "peak.ts",
  "balance.ts",
  "holidays.ts",
  "update-check.ts",
];

const PLUGIN_DIR_NAME = "deepseek-peak";

function resolveAgentDir() {
  const explicit = process.env.OMP_DEEPSEEK_AGENT_DIR?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".omp", "agent");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const verifyOnly = process.argv.includes("--verify");
const target = join(resolveAgentDir(), "extensions", PLUGIN_DIR_NAME);

console.log(`源目录   ${ROOT}`);
console.log(`目标目录 ${target}`);
console.log(verifyOnly ? "模式     只比对 (--verify)\n" : "模式     复制\n");

if (verifyOnly && !existsSync(target)) {
  console.error(`✘ 目标目录不存在。先执行：npm run deploy`);
  process.exit(1);
}

if (!verifyOnly) mkdirSync(target, { recursive: true });

let copied = 0;
let same = 0;
let missing = 0;
let differing = 0;

for (const file of RUNTIME_FILES) {
  const from = join(ROOT, file);
  const to = join(target, file);

  if (!existsSync(from)) {
    console.error(`✘ 源文件缺失：${file}`);
    process.exit(1);
  }

  if (verifyOnly) {
    if (!existsSync(to)) {
      console.log(`✘ ${file.padEnd(16)} 目标缺失`);
      missing += 1;
      continue;
    }
    if (sha256(from) === sha256(to)) {
      console.log(`✓ ${file.padEnd(16)} 一致`);
      same += 1;
    } else {
      console.log(`✘ ${file.padEnd(16)} 不一致（已安装的是旧版本）`);
      differing += 1;
    }
    continue;
  }

  copyFileSync(from, to);
  console.log(`→ ${file}`);
  copied += 1;
}

console.log("");

if (verifyOnly) {
  if (missing + differing === 0) {
    console.log(`全部同步（${same} 个文件）`);
    process.exit(0);
  }
  console.error(`不同步：${missing} 个缺失，${differing} 个内容不同`);
  console.error("执行 npm run deploy 后重启 omp。");
  process.exit(1);
}

console.log(`已部署 ${copied} 个文件。重启 omp 后生效，在 omp 里用 /ds 打开面板。`);
