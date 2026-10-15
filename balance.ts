/**
 * DeepSeek 余额查询。
 *
 * 官方接口：GET https://api.deepseek.com/user/balance
 * 文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance/
 *
 * DeepSeek 没有提供 token 用量或消费历史接口，因此本模块只负责余额本身。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const REQUEST_TIMEOUT_MS = 12_000;

export interface BalanceInfo {
  currency: string;
  /** 总可用余额 = 赠金 + 充值余额。 */
  total: number;
  /** 未过期的赠金余额。 */
  granted: number;
  /** 充值余额。 */
  toppedUp: number;
}

export interface BalanceSnapshot {
  isAvailable: boolean;
  infos: BalanceInfo[];
  fetchedAt: number;
}

export type KeyResolution =
  | { ok: true; key: string; source: string }
  | { ok: false; message: string };

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * omp 的 agent 目录。优先问宿主，其次按文档顺序回退，
 * 以便 `omp --profile <name>` 这类多配置场景也能找到凭据。
 */
async function resolveAgentDir(): Promise<string> {
  const explicit = process.env.OMP_DEEPSEEK_AGENT_DIR?.trim();
  if (explicit) return explicit;

  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;

  try {
    const mod = (await import("@oh-my-pi/pi-coding-agent")) as {
      getAgentDir?: () => string;
    };
    const dir = mod.getAgentDir?.();
    if (typeof dir === "string" && dir.trim()) return dir;
  } catch {
    // 宿主导出不可用时回退到约定路径。
  }

  return join(homedir(), ".omp", "agent");
}

/** 读取 pi 传统格式的 auth.json（部分版本使用）。 */
function readKeyFromAuthJson(agentDir: string): string | undefined {
  const path = join(agentDir, "auth.json");
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const entry = parsed?.deepseek;
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      for (const field of ["key", "apiKey", "api_key", "token"]) {
        const value = record[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  } catch {
    // 解析失败按未找到处理。
  }
  return undefined;
}

function decodeData(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return undefined;
}

/**
 * 读取 omp 存放凭据的 SQLite 库。
 *
 * omp 把登录凭据存在 `<agentDir>/agent.db` 的 `auth_credentials` 表里，
 * provider = 'deepseek'，data 为 JSON 字符串 `{"key":"sk-...","source":"login"}`。
 * 这是内部结构，因此整段都用 try/catch 包住：读不到就让上层给出提示。
 */
async function readKeyFromAgentDb(agentDir: string): Promise<string | undefined> {
  const dbPath = join(agentDir, "agent.db");
  if (!existsSync(dbPath)) return undefined;

  let Ctor: (new (path: string, options?: unknown) => SqliteLike) | undefined;
  let bunFirst = true;

  try {
    const mod = (await import("bun:sqlite")) as { Database?: unknown; DatabaseSync?: unknown };
    Ctor = (mod.Database ?? mod.DatabaseSync) as typeof Ctor;
  } catch {
    try {
      const mod = (await import("node:sqlite")) as { DatabaseSync?: unknown; Database?: unknown };
      Ctor = (mod.DatabaseSync ?? mod.Database) as typeof Ctor;
      bunFirst = false;
    } catch {
      return undefined;
    }
  }
  if (typeof Ctor !== "function") return undefined;

  let db: SqliteLike | undefined;
  try {
    db = new Ctor(dbPath, bunFirst ? { readonly: true } : { readOnly: true });
    const row = db
      .prepare("SELECT data FROM auth_credentials WHERE provider = ? LIMIT 1")
      .get("deepseek") as { data?: unknown } | undefined;

    const raw = decodeData(row?.data);
    if (raw === undefined) return undefined;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const key = parsed?.key;
    if (typeof key === "string" && key.trim()) return key.trim();
    return undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // 关闭失败无需处理。
    }
  }
}

interface SqliteLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

/** 按固定优先级解析 DeepSeek API key。 */
export async function resolveApiKey(): Promise<KeyResolution> {
  const override = process.env.OMP_DEEPSEEK_API_KEY?.trim();
  if (override) {
    return { ok: true, key: override, source: "环境变量 OMP_DEEPSEEK_API_KEY" };
  }

  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) {
    return { ok: true, key: fromEnv, source: "环境变量 DEEPSEEK_API_KEY" };
  }

  const agentDir = await resolveAgentDir();

  const fromJson = readKeyFromAuthJson(agentDir);
  if (fromJson) {
    return { ok: true, key: fromJson, source: join(agentDir, "auth.json") };
  }

  const fromDb = await readKeyFromAgentDb(agentDir);
  if (fromDb) {
    return {
      ok: true,
      key: fromDb,
      source: `${join(agentDir, "agent.db")} → auth_credentials(deepseek)`,
    };
  }

  return {
    ok: false,
    message:
      "未找到 DeepSeek API key。可在 omp 中用 /login 登录 DeepSeek，或设置环境变量 DEEPSEEK_API_KEY。" +
      `已查找：环境变量 OMP_DEEPSEEK_API_KEY / DEEPSEEK_API_KEY、${join(agentDir, "auth.json")}、${join(agentDir, "agent.db")}`,
  };
}

/** 查询账户余额，失败时抛出带可读原因的异常。 */
export async function fetchBalance(
  key: string,
  externalSignal?: AbortSignal,
): Promise<BalanceSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const response = await fetch(BALANCE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body ? `: ${truncate(body.replace(/\s+/g, " ").trim(), 200)}` : "";
      if (response.status === 401 || response.status === 403) {
        throw new Error(`凭据被拒绝 (HTTP ${response.status})${detail}`);
      }
      throw new Error(`余额接口返回 HTTP ${response.status}${detail}`);
    }

    const payload = (await response.json()) as {
      is_available?: unknown;
      balance_infos?: unknown;
    };

    const rows = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const infos: BalanceInfo[] = rows.map((row) => {
      const record = (row ?? {}) as Record<string, unknown>;
      return {
        currency: typeof record.currency === "string" ? record.currency : "?",
        total: toNumber(record.total_balance),
        granted: toNumber(record.granted_balance),
        toppedUp: toNumber(record.topped_up_balance),
      };
    });

    return { isAvailable: payload?.is_available === true, infos, fetchedAt: Date.now() };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * 选取要展示的货币行。
 *
 * 不直接取第一行：零余额的 USD 行会遮住有余额的 CNY 行。
 * 顺序：有余额的 CNY → 首个有余额的行 → CNY 行 → 第一行。
 */
export function pickPrimary(infos: readonly BalanceInfo[]): BalanceInfo | undefined {
  const positive = infos.filter((info) => info.total > 0);
  return (
    positive.find((info) => info.currency === "CNY") ??
    positive[0] ??
    infos.find((info) => info.currency === "CNY") ??
    infos[0]
  );
}

export function currencySymbol(currency: string): string {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  return `${currency} `;
}

export function formatAmount(value: number, currency: string): string {
  return `${currencySymbol(currency)}${value.toFixed(2)}`;
}
