/**
 * deepseek-peak —— 为 oh-my-pi (omp) 提供 DeepSeek 余额与峰谷时段的可视化。
 *
 * 组成：
 *   - 状态栏段：余额 + 当前峰谷状态 + 距下次切换的倒计时
 *   - /ds 命令：TUI 覆盖层面板（余额明细、当前时段、今日时间轴、规则说明）
 *
 * 峰谷规则见 peak.ts，余额接口见 balance.ts。
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { Component, Theme, TUI } from "@oh-my-pi/pi-tui";

import {
  fetchBalance,
  formatAmount,
  pickPrimary,
  resolveApiKey,
  type BalanceSnapshot,
  type KeyResolution,
} from "./balance.ts";
import {
  beijingStamp,
  classifyAt,
  coveredYears,
  daySegments,
  formatDuration,
  formatDurationCompact,
  formatMinuteOfDay,
  isYearCovered,
  nextTransition,
  peakMinutesOfDay,
  phaseLabel,
  phaseReasonLabel,
  weekdayLabel,
  type PeakOptions,
  type Phase,
} from "./peak.ts";
import {
  checkHolidayDataUpdate,
  getCachedUpdateCheck,
  updateHint,
} from "./update-check.ts";

const STATUS_KEY = "deepseek-peak";
const BALANCE_REFRESH_THROTTLE_MS = 5 * 60_000;
const STATUS_TICK_MS = 1000;

type Timer = ReturnType<ExtensionContext["setInterval"]>;

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseDateSet(value: string | undefined): ReadonlySet<string> | undefined {
  if (!value) return undefined;
  const items = value
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  return items.length > 0 ? new Set(items) : undefined;
}

function readOptions(): PeakOptions {
  return {
    extraHolidays: parseDateSet(process.env.OMP_DEEPSEEK_EXTRA_HOLIDAYS),
    extraMakeupWorkdays: parseDateSet(process.env.OMP_DEEPSEEK_MAKEUP_WORKDAYS),
    makeupWorkdaysArePeak: isTruthy(process.env.OMP_DEEPSEEK_MAKEUP_AS_PEAK),
  };
}

/** 面板/摘要共用的状态快照。 */
interface ViewState {
  snapshot: BalanceSnapshot | undefined;
  key: KeyResolution | undefined;
  error: string | undefined;
  refreshing: boolean;
}

function describeBalance(state: ViewState): { text: string; currency: string } | undefined {
  const primary = state.snapshot ? pickPrimary(state.snapshot.infos) : undefined;
  if (!primary) return undefined;
  return { text: formatAmount(primary.total, primary.currency), currency: primary.currency };
}

/** 状态栏一行的内容（带主题色）。 */
function buildStatusText(theme: Theme, state: ViewState, phase: Phase, transition: ReturnType<typeof nextTransition>): string {
  const parts: string[] = [theme.fg("accent", "DS")];

  const balance = describeBalance(state);
  if (balance) {
    parts.push(theme.bold(balance.text));
  } else if (state.error || (state.key && !state.key.ok)) {
    parts.push(theme.fg("error", "余额不可用"));
  } else {
    parts.push(theme.fg("dim", "…"));
  }

  const label = phase.kind === "peak" ? "高峰" : "空闲½";
  parts.push(
    phase.kind === "peak"
      ? theme.fg("warning", label)
      : theme.fg("success", label),
  );

  if (transition) {
    const target = transition.phase.kind === "peak" ? "高峰" : "空闲";
    parts.push(
      theme.fg("dim", `${formatDurationCompact(transition.inMs)}→${target}`),
    );
  }

  return parts.join(theme.fg("dim", " │ "));
}

/** 非 TUI 模式下的纯文本摘要。 */
function buildPlainSummary(state: ViewState, options: PeakOptions): string {
  const now = new Date();
  const stamp = beijingStamp(now);
  const phase = classifyAt(now, options);
  const transition = nextTransition(now, options);
  const lines: string[] = [];

  lines.push(`DeepSeek 余额与峰谷时段（北京时间 ${stamp.dateKey} ${weekdayLabel(stamp.weekday)} ${formatMinuteOfDay(stamp.minutesOfDay)}）`);

  if (state.snapshot) {
    for (const info of state.snapshot.infos) {
      lines.push(
        `余额 ${formatAmount(info.total, info.currency)}（赠金 ${formatAmount(info.granted, info.currency)} / 充值 ${formatAmount(info.toppedUp, info.currency)}）`,
      );
    }
    if (state.snapshot.infos.length === 0) lines.push("余额：接口未返回任何币种行");
  } else if (state.error) {
    lines.push(`余额：获取失败 —— ${state.error}`);
  } else if (state.key && !state.key.ok) {
    lines.push(`余额：${state.key.message}`);
  } else {
    lines.push("余额：尚未获取");
  }

  lines.push(`当前：${phaseLabel(phase)}（${phaseReasonLabel(phase)}）`);
  if (transition) {
    const target = transition.phase.kind === "peak" ? "高峰" : "空闲";
    lines.push(`距切换到${target}还有 ${formatDuration(transition.inMs)}`);
  }

  const peakMinutes = peakMinutesOfDay(stamp.dateKey, options);
  lines.push(
    `今日高峰 ${(peakMinutes / 60).toFixed(1)} 小时 / 空闲 ${((1440 - peakMinutes) / 60).toFixed(1)} 小时`,
  );

  const hint = updateHint(getCachedUpdateCheck());
  if (hint !== undefined) lines.push(hint);

  return lines.join("\n");
}

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  let out = "";
  let width = 0;
  for (const char of plain) {
    const charWidth = visibleWidth(char);
    if (width + charWidth > max - 1) break;
    out += char;
    width += charWidth;
  }
  return `${out}…`;
}

/** 画今日峰谷时间轴。 */
function buildTimeline(
  theme: Theme,
  dateKey: string,
  options: PeakOptions,
  width: number,
  nowMinutes: number,
): string[] {
  const rows: string[] = [];
  const prefix = "00:00 ";
  const suffix = " 24:00";
  const overhead = visibleWidth(prefix) + visibleWidth(suffix);
  const barWidth = Math.max(12, width - overhead);

  const segments = daySegments(dateKey, options);
  let bar = "";
  for (let cell = 0; cell < barWidth; cell += 1) {
    const minute = Math.floor(((cell + 0.5) * 1440) / barWidth);
    const kind = segments.find((segment) => minute >= segment.startMin && minute < segment.endMin)?.kind ?? "offpeak";
    bar += kind === "peak" ? theme.fg("warning", "█") : theme.fg("muted", "░");
  }
  rows.push(theme.fg("dim", prefix) + bar + theme.fg("dim", suffix));

  const markerColumn = Math.min(
    barWidth - 1,
    Math.max(0, Math.floor((nowMinutes / 1440) * barWidth)),
  );
  rows.push(
    " ".repeat(visibleWidth(prefix) + markerColumn) +
      theme.fg("accent", "▲") +
      theme.fg("dim", " 现在"),
  );

  return rows;
}

/** /ds 面板：自绘组件，直接返回行数组。 */
class PeakPanel implements Component {
  readonly debugId = "deepseek-peak-panel";

  private state: ViewState;
  private readonly options: PeakOptions;
  private timer: Timer | undefined;
  private busy = false;

  constructor(
    private readonly deps: {
      tui: TUI;
      theme: Theme;
      ctx: ExtensionContext;
      initial: ViewState;
      options: PeakOptions;
      onRefresh: () => Promise<ViewState>;
      done: () => void;
    },
  ) {
    this.state = deps.initial;
    this.options = deps.options;
    this.timer = deps.ctx.setInterval(() => {
      this.deps.tui.requestRender();
    }, STATUS_TICK_MS);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.deps.ctx.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  handleInput(data: string): void {
    if (data === "\u001b" || data === "\r" || data === "\n" || data === "q") {
      this.deps.done();
      return;
    }
    if (data === "r") {
      void this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.state = { ...this.state, refreshing: true };
    this.deps.tui.requestRender();
    try {
      this.state = await this.deps.onRefresh();
    } finally {
      this.busy = false;
      this.deps.tui.requestRender();
    }
  }

  render(width: number): readonly string[] {
    return this.frame(this.content(width), width);
  }

  private frame(lines: readonly string[], width: number): string[] {
    const theme = this.deps.theme;
    const glyphs = theme.boxRound;
    const border = (text: string) => theme.fg("border", text);
    const innerWidth = Math.max(8, width - 2);

    const out: string[] = [];
    out.push(border(glyphs.topLeft + glyphs.horizontal.repeat(innerWidth) + glyphs.topRight));
    for (const line of lines) {
      const text = clip(line, innerWidth - 1);
      const padding = Math.max(0, innerWidth - 1 - visibleWidth(text));
      out.push(
        border(glyphs.vertical) + " " + text + " ".repeat(padding) + border(glyphs.vertical),
      );
    }
    out.push(border(glyphs.bottomLeft + glyphs.horizontal.repeat(innerWidth) + glyphs.bottomRight));
    return out;
  }

  private content(width: number): string[] {
    const theme = this.deps.theme;
    const now = new Date();
    const stamp = beijingStamp(now);
    const phase = classifyAt(now, this.options);
    const transition = nextTransition(now, this.options);
    const lines: string[] = [];
    const maxText = Math.max(20, width - 3);

    const heading = (text: string) => theme.bold(theme.fg("accent", text));

    lines.push(heading("DeepSeek 余额 · 峰谷时段"));
    lines.push("");

    // ---- 账户余额 ----
    lines.push(theme.fg("muted", "账户余额"));
    const balance = describeBalance(this.state);
    if (balance) {
      lines.push(`${theme.bold(balance.text)}  ${theme.fg("dim", "总可用余额")}`);
      const primary = pickPrimary(this.state.snapshot?.infos ?? [])!;
      lines.push(
        theme.fg("dim", `赠金 ${formatAmount(primary.granted, primary.currency)} · 充值 ${formatAmount(primary.toppedUp, primary.currency)} · 赠金优先扣减`),
      );
      const others = (this.state.snapshot?.infos ?? []).filter((info) => info !== primary);
      for (const other of others) {
        lines.push(theme.fg("dim", `其他币种 ${formatAmount(other.total, other.currency)}`));
      }
      const age = formatDuration(Date.now() - (this.state.snapshot?.fetchedAt ?? Date.now()));
      const source = this.state.key?.ok ? this.state.key.source : "未知来源";
      lines.push(theme.fg("dim", `更新于 ${age}前 · ${source}`));
      if (this.state.snapshot?.isAvailable === false) {
        lines.push(theme.fg("warning", "⚠ 账户余额不足，API 调用可能失败"));
      }
    } else if (this.state.key && !this.state.key.ok) {
      lines.push(theme.fg("error", "未配置 DeepSeek 凭据"));
      for (const part of this.state.key.message.split("已查找：")) {
        lines.push(theme.fg("dim", part.trim() === "" ? "" : clip(part.trim(), maxText)));
      }
    } else if (this.state.error) {
      lines.push(theme.fg("error", `获取失败：${this.state.error}`));
      if (this.state.refreshing) lines.push(theme.fg("dim", "正在重试…"));
    } else {
      lines.push(theme.fg("dim", this.state.refreshing ? "正在获取…" : "尚未获取，按 r 刷新"));
    }
    lines.push("");

    // ---- 当前时段 ----
    lines.push(theme.fg("muted", "当前时段"));
    const label = phaseLabel(phase);
    lines.push(
      phase.kind === "peak"
        ? theme.fg("warning", `▌ ${label}`)
        : theme.fg("success", `▌ ${label}`),
    );
    lines.push(theme.fg("dim", phaseReasonLabel(phase)));
    if (transition) {
      const target = transition.phase.kind === "peak" ? "高峰" : "空闲·半价";
      lines.push(
        `距切换到${target}还有 ${theme.bold(formatDuration(transition.inMs))}` +
          theme.fg("dim", `（${formatMinuteOfDay(beijingStamp(transition.at).minutesOfDay)}）`),
      );
    }
    if (phase.makeupWorkday !== undefined) {
      lines.push(theme.fg("dim", `本日为调休上班日（${phase.makeupWorkday}）`));
    }
    lines.push("");

    // ---- 今日 ----
    const peakMinutes = peakMinutesOfDay(stamp.dateKey, this.options);
    lines.push(theme.fg("muted", "今日"));
    lines.push(
      theme.fg(
        "dim",
        `${stamp.dateKey} ${weekdayLabel(stamp.weekday)} · 高峰 ${(peakMinutes / 60).toFixed(1)}h / 空闲 ${((1440 - peakMinutes) / 60).toFixed(1)}h`,
      ),
    );
    if (!isYearCovered(stamp.year)) {
      lines.push(
        theme.fg(
          "warning",
          `⚠ ${stamp.year} 年放假安排未纳入内置日历（已覆盖 ${coveredYears().join("/")}），节假日可能误判为高峰`,
        ),
      );
    }
    for (const row of buildTimeline(theme, stamp.dateKey, this.options, maxText, stamp.minutesOfDay)) {
      lines.push(row);
    }
    lines.push("");
    lines.push(theme.fg("dim", "█ 高峰（全价）   ░ 空闲（半价）"));
    lines.push("");

    // ---- 规则 ----
    lines.push(theme.fg("muted", "高峰时段规则"));
    lines.push(theme.fg("dim", "北京时间 周一至周五（非法定节假日）"));
    lines.push(theme.fg("dim", "09:00-12:00 与 14:00-18:00 为高峰"));
    lines.push(theme.fg("dim", "其余时段含周末与法定节假日全天为空闲，价格减半"));
    if (this.options.makeupWorkdaysArePeak) {
      lines.push(theme.fg("warning", "已启用：调休上班的周末按高峰计算"));
    } else {
      lines.push(theme.fg("dim", "调休上班的周末按官方字面规则仍算空闲"));
    }

    const hint = updateHint(getCachedUpdateCheck());
    if (hint !== undefined) {
      lines.push("");
      lines.push(theme.fg("accent", `↑ ${hint}`));
      lines.push(theme.fg("dim", "更新需手动确认：重新生成后复制到扩展目录"));
    }
    lines.push("");

    lines.push(theme.fg("dim", "r 刷新余额   Esc/Enter 关闭"));
    return lines;
  }
}

export default function deepseekPeak(pi: ExtensionAPI): void {
  pi.setLabel("DeepSeek 余额 · 峰谷时段");

  const options = readOptions();
  const hideStatus = isTruthy(process.env.OMP_DEEPSEEK_HIDE_STATUS);

  let state: ViewState = { snapshot: undefined, key: undefined, error: undefined, refreshing: false };
  let lastFetchAt = 0;
  let lastStatusText = "";
  let statusTimer: Timer | undefined;
  /** 已就哪个上游版本提示过，避免重复打扰。 */
  let notifiedUpdateFor: string | undefined;

  const isSubagent = (ctx: ExtensionContext): boolean =>
    (ctx as { agent?: { kind?: string } }).agent?.kind === "sub";

  async function refresh(): Promise<ViewState> {
    if (state.refreshing) return state;
    state = { ...state, refreshing: true };

    const key = state.key ?? (await resolveApiKey());
    if (!key.ok) {
      state = { snapshot: undefined, key, error: undefined, refreshing: false };
      return state;
    }

    try {
      const snapshot = await fetchBalance(key.key);
      lastFetchAt = Date.now();
      state = { snapshot, key, error: undefined, refreshing: false };
    } catch (error) {
      state = {
        snapshot: state.snapshot,
        key,
        error: error instanceof Error ? error.message : String(error),
        refreshing: false,
      };
    }
    return state;
  }

  function pushStatus(ctx: ExtensionContext): void {
    if (hideStatus || isSubagent(ctx) || !ctx.hasUI) return;
    const now = new Date();
    const text = buildStatusText(ctx.ui.theme, state, classifyAt(now, options), nextTransition(now, options));
    if (text === lastStatusText) return;
    lastStatusText = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (isSubagent(ctx)) return;
    if (statusTimer !== undefined) ctx.clearTimer(statusTimer);
    statusTimer = ctx.setInterval(() => pushStatus(ctx), STATUS_TICK_MS);
    pushStatus(ctx);

    // 更新检查不阻塞启动：只查版本号元数据，失败也不影响任何功能。
    void (async () => {
      const check = await checkHolidayDataUpdate();
      const hint = updateHint(check);
      if (hint !== undefined && check !== undefined && notifiedUpdateFor !== check.latest) {
        notifiedUpdateFor = check.latest;
        ctx.ui.notify(`${hint}。更新后重新安装扩展即可。`, "info");
      }
      pushStatus(ctx);
    })();

    await refresh();
    pushStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (isSubagent(ctx)) return;
    if (Date.now() - lastFetchAt < BALANCE_REFRESH_THROTTLE_MS) return;
    await refresh();
    pushStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (statusTimer !== undefined) {
      ctx.clearTimer(statusTimer);
      statusTimer = undefined;
    }
    lastStatusText = "";
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("ds", {
    description: "查看 DeepSeek 余额与峰谷时段（TUI 面板；/ds json 输出纯文本）",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();

      if (mode === "json" || mode === "text") {
        const key = state.key ?? (await resolveApiKey());
        if (!key.ok && state.snapshot === undefined) {
          state = { ...state, key };
        }
        ctx.ui.notify(buildPlainSummary(state, options), "info");
        return;
      }

      if (mode === "refresh") {
        await refresh();
      } else if (mode !== "" && mode !== "panel") {
        ctx.ui.notify(`未知参数「${args.trim()}」。可用：/ds、/ds refresh、/ds json`, "warning");
        return;
      } else if (Date.now() - lastFetchAt > 60_000) {
        await refresh();
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify(buildPlainSummary(state, options), "info");
        return;
      }

      if (state.key === undefined) {
        state = { ...state, key: await resolveApiKey() };
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new PeakPanel({
            tui,
            theme,
            ctx,
            initial: state,
            options,
            onRefresh: refresh,
            done: () => done(undefined),
          }),
        {
          overlay: true,
          overlayOptions: {
            width: "86%",
            minWidth: 52,
            maxHeight: "90%",
            anchor: "center",
          },
        },
      );
    },
  });
}
