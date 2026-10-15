/**
 * 节假日数据更新检查。
 *
 * 只做一件事：向 npm registry 查一次 `chinese-days` 的**版本号元数据**，与
 * holidays.ts 里记录的生成版本比对，有新版本就在面板里提示你去手动更新。
 *
 * 明确不做的事：
 *   - 不下载包、不下载数据、不执行任何来自网络的代码
 *   - 不写任何文件
 *   - 不发送任何凭据或标识信息
 *
 * 关闭方式：设置 OMP_DEEPSEEK_NO_UPDATE_CHECK=1。
 */
import { DATA_SOURCE } from "./holidays.ts";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface UpdateCheck {
  /** 本地 holidays.ts 的生成版本。 */
  current: string;
  /** registry 上的最新版本。 */
  latest: string;
  /** registry 版本高于本地版本。 */
  hasUpdate: boolean;
  checkedAt: number;
}

interface CacheEntry {
  at: number;
  result?: UpdateCheck;
  error?: string;
}

let cache: CacheEntry | undefined;

function isDisabled(): boolean {
  const value = process.env.OMP_DEEPSEEK_NO_UPDATE_CHECK?.trim().toLowerCase();
  if (value === undefined || value === "") return false;
  return ["1", "true", "yes", "on"].includes(value);
}

/** 语义化版本比较：a 高于 b 返回 1，相等返回 0，低于返回 -1。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 同步读取上一次检查结果，供面板渲染使用（不触发网络）。 */
export function getCachedUpdateCheck(): UpdateCheck | undefined {
  return cache?.result;
}

export function getUpdateCheckError(): string | undefined {
  return cache?.error;
}

export function isUpdateCheckDisabled(): boolean {
  return isDisabled();
}

/**
 * 检查上游数据是否有更新。
 *
 * 结果缓存 24 小时，因此正常情况下每个 omp 进程至多产生一次请求。
 * 网络失败不会抛出，只会记录错误并返回 undefined——检查失败绝不影响任何功能。
 */
export async function checkHolidayDataUpdate(force = false): Promise<UpdateCheck | undefined> {
  if (isDisabled()) return undefined;

  const now = Date.now();
  if (!force && cache !== undefined && now - cache.at < CHECK_INTERVAL_MS) {
    return cache.result;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://registry.npmjs.org/${DATA_SOURCE.package}/latest`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      cache = { at: now, error: `registry 返回 HTTP ${response.status}` };
      return undefined;
    }

    const payload = (await response.json()) as { version?: unknown };
    const latest = typeof payload?.version === "string" ? payload.version : undefined;
    if (latest === undefined) {
      cache = { at: now, error: "registry 响应中没有 version 字段" };
      return undefined;
    }

    const result: UpdateCheck = {
      current: DATA_SOURCE.version,
      latest,
      hasUpdate: compareVersions(latest, DATA_SOURCE.version) > 0,
      checkedAt: now,
    };
    cache = { at: now, result };
    return result;
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`
        : error instanceof Error
          ? error.message
          : String(error);
    cache = { at: now, error: message };
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 提示文案；无更新或检查失败时返回 undefined。 */
export function updateHint(check: UpdateCheck | undefined): string | undefined {
  if (check === undefined || !check.hasUpdate) return undefined;
  return `节假日数据可更新：chinese-days ${check.current} → ${check.latest}`;
}
