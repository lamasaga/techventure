import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { V6, CITY_IDS } from "../engine/config.js";
import type { CityId, EventId, RouteId } from "../engine/config.js";
import type { NewsItem, SettlementOutput, TeamSettlementResult } from "../engine/contracts.js";

export const STATE_SCHEMA = "techventure-v6.0" as const;
export type RoundStatus = "pending" | "open" | "settled";

/** 队伍持久化记录。 */
export interface TeamRow {
  id: string;
  /** 主办方分配的编号（登录用，大小写不敏感） */
  team_code: string;
  /** 口令（可为空） */
  pin: string;
  /** 队伍名（公开展示） */
  team_name: string;
  /** 科技产品名（公开展示） */
  product_name: string;

  /** 战略路线（R1 锁定，R2+ 可切换） */
  route: RouteId;
  /** 主场城市（路演锁定） */
  homeCity: CityId;
  /** 已开通经营的城市集合 */
  opened_cities: CityId[];

  tech: number;
  fit_by_city: Record<CityId, number>;
  show_by_city: Record<CityId, number>;

  /** 当前可用资金（储备 + 追加；每轮 Step 0 会在 services 中更新） */
  budget: number;
  /** 计算 Step 0 时使用的 follow_on 余额（上轮产出，下轮到账） */
  pending_follow_on: number;

  attention_total: number;
  weighted_total: number;

  last_rank: number | null;
  /** 已弃用：曾用于追加投资连续递减；现恒写 0，读档兼容。 */
  consecutive_top3: number;
}

export interface RoundRow {
  id: number;
  round_no: 1 | 2 | 3 | 4;
  status: RoundStatus;
  /** 仅 R3 允许非 none；其它轮恒为 none */
  event_id: EventId;
  /** 管理端显示用：本轮可用资金上限倍率（当前版本恒为 1；字段保留用于兼容与展示） */
  spend_cap_multiplier: number;
  /** 本轮开放提交的开始时间（ISO）；用于倒计时与自动结算 */
  opened_at?: string | null;
}

/** 参赛队伍本轮决策。 */
export interface SubmissionRow {
  id: number;
  round_id: number;
  team_id: string;
  /** 本轮所选路线（可能为切换后） */
  route: RouteId;
  /** 本轮最终已开通城（可能新增） */
  opened_cities: CityId[];
  invest_tech: number;
  invest_fit_by_city: Record<CityId, number>;
  invest_show_by_city: Record<CityId, number>;
  declaration: string;
  /** 本轮实际支付的切换费 / 开城费（用于反查） */
  switch_cost_paid: number;
  expand_cost_paid: number;
  created_at: string;
}

/** 结算快照（整轮产出）—— 按队伍存一份以便参赛端/投资人回放。 */
export interface SnapshotRow {
  id: number;
  round_id: number;
  team_id: string;
  /** TeamSettlementResult 的 JSON */
  payload: string;
}

/** 整轮产出（大屏饼图、新闻、事件等）。 */
export interface RoundReportRow {
  round_id: number;
  payload: string; // SettlementOutput 的 JSON
}

export interface NewsRow {
  id: number;
  round_no: number;
  kind: NewsItem["kind"];
  headline: string;
  body: string;
  team_ids: string[];
  created_at: string;
}

export interface AppState {
  schema: string;
  teams: TeamRow[];
  rounds: RoundRow[];
  submissions: SubmissionRow[];
  snapshots: SnapshotRow[];
  roundReports: RoundReportRow[];
  news: NewsRow[];
  nextSubmissionId: number;
  nextSnapshotId: number;
  nextNewsId: number;
}

export function defaultState(): AppState {
  const rounds: RoundRow[] = [];
  for (let i = 1; i <= V6.ROUNDS; i++) {
    rounds.push({
      id: i,
      round_no: i as 1 | 2 | 3 | 4,
      status: "pending",
      event_id: "none",
      spend_cap_multiplier: 1,
      opened_at: null,
    });
  }
  return {
    schema: STATE_SCHEMA,
    teams: [],
    rounds,
    submissions: [],
    snapshots: [],
    roundReports: [],
    news: [],
    nextSubmissionId: 1,
    nextSnapshotId: 1,
    nextNewsId: 1,
  };
}

export function blankFitShowByCity(): Record<CityId, number> {
  const o: Record<CityId, number> = { 南京: V6.A_INIT, 合肥: V6.A_INIT, 杭州: V6.A_INIT };
  return o;
}

export function blankInvestByCity(): Record<CityId, number> {
  const o: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
  return o;
}

export function getStatePath(): string {
  if (process.env.TV_DB_PATH) return process.env.TV_DB_PATH;
  return join(process.cwd(), "data", "techventure.json");
}

let state: AppState | null = null;

function atomicWriteFile(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.techventure-${Date.now()}.tmp`);
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

export function initPersistence(): void {
  const path = getStatePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AppState> & { schema?: string };
      if (parsed.schema !== STATE_SCHEMA) {
        // 旧版本 schema，不兼容：直接重置
        state = defaultState();
        persist();
        return;
      }
      state = {
        schema: STATE_SCHEMA,
        teams: parsed.teams ?? [],
        rounds: parsed.rounds && parsed.rounds.length === V6.ROUNDS ? parsed.rounds : defaultState().rounds,
        submissions: parsed.submissions ?? [],
        snapshots: parsed.snapshots ?? [],
        roundReports: parsed.roundReports ?? [],
        news: parsed.news ?? [],
        nextSubmissionId: parsed.nextSubmissionId ?? (parsed.submissions?.reduce((m, x) => Math.max(m, x.id), 0) ?? 0) + 1,
        nextSnapshotId: parsed.nextSnapshotId ?? (parsed.snapshots?.reduce((m, x) => Math.max(m, x.id), 0) ?? 0) + 1,
        nextNewsId: parsed.nextNewsId ?? (parsed.news?.reduce((m, x) => Math.max(m, x.id), 0) ?? 0) + 1,
      };
      for (const r of state.rounds) {
        if (!("opened_at" in r)) r.opened_at = null;
        if (r.opened_at !== null && typeof r.opened_at !== "string") r.opened_at = null;
      }
      // 兜底：队伍字段补齐
      for (const t of state.teams) {
        if (!t.fit_by_city) t.fit_by_city = blankFitShowByCity();
        if (!t.show_by_city) t.show_by_city = blankFitShowByCity();
        for (const c of CITY_IDS) {
          if (typeof t.fit_by_city[c] !== "number") t.fit_by_city[c] = V6.A_INIT;
          if (typeof t.show_by_city[c] !== "number") t.show_by_city[c] = V6.A_INIT;
        }
        if (!Array.isArray(t.opened_cities)) t.opened_cities = [t.homeCity ?? "杭州"];
        if (typeof t.consecutive_top3 !== "number") t.consecutive_top3 = 0;
        if (typeof t.pending_follow_on !== "number") t.pending_follow_on = 0;
        if (typeof t.weighted_total !== "number") t.weighted_total = 0;
        if (typeof t.attention_total !== "number") t.attention_total = 0;
      }
    } catch {
      state = defaultState();
      persist();
    }
  } else {
    state = defaultState();
    persist();
  }
}

export function persist(): void {
  if (!state) throw new Error("state not initialized");
  atomicWriteFile(getStatePath(), JSON.stringify(state));
}

export function getState(): AppState {
  if (!state) initPersistence();
  return state!;
}

/** 存入整轮结算产出（快照 + 报告 + 新闻）。 */
export function saveSettlementOutput(roundId: number, output: SettlementOutput): void {
  const s = getState();
  // 清掉该轮旧快照（防止多次结算）
  s.snapshots = s.snapshots.filter((x) => x.round_id !== roundId);
  s.roundReports = s.roundReports.filter((x) => x.round_id !== roundId);
  s.news = s.news.filter((x) => x.round_no !== output.roundNo);
  for (const r of output.results) {
    s.snapshots.push({
      id: s.nextSnapshotId++,
      round_id: roundId,
      team_id: r.teamId,
      payload: JSON.stringify(r),
    });
  }
  s.roundReports.push({ round_id: roundId, payload: JSON.stringify(output) });
  for (const n of output.news) {
    s.news.push({
      id: s.nextNewsId++,
      round_no: output.roundNo,
      kind: n.kind,
      headline: n.headline,
      body: n.body,
      team_ids: n.teamIds,
      created_at: new Date().toISOString(),
    });
  }
}

export function getRoundReport(roundId: number): SettlementOutput | null {
  const s = getState();
  const row = s.roundReports.find((x) => x.round_id === roundId);
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as SettlementOutput;
  } catch {
    return null;
  }
}

export function getTeamSnapshot(roundId: number, teamId: string): TeamSettlementResult | null {
  const s = getState();
  const row = s.snapshots.find((x) => x.round_id === roundId && x.team_id === teamId);
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as TeamSettlementResult;
  } catch {
    return null;
  }
}
