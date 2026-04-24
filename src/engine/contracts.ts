/**
 * v6.0 结算引擎契约。
 * 业务层仅依赖本文件定义的类型；与 v6.0 核心公式文档中的术语一一对应。
 */

import type { CityId, EventId, GroupId, RouteId } from "./config.js";
export type { CityId, EventId, GroupId, RouteId };

/** 队伍进入某一轮结算前的快照（上一轮末或初始态）。 */
export interface TeamEngineSnapshot {
  id: string;
  displayName: string;
  productName: string;
  /** 当前战略路线 */
  route: RouteId;
  /** 已开通经营的城市集合 */
  openedCities: CityId[];
  /** 全局 Tech 属性 */
  tech: number;
  /** 每城 Fit / Show（未开通城保持 A_INIT） */
  fitByCity: Record<CityId, number>;
  showByCity: Record<CityId, number>;
  /** 上轮排名；首轮为 null */
  lastRank: number | null;
  /** 已弃用：曾用于 follow_on 连续递减，现恒不参与计算；读档兼容保留字段。 */
  consecutiveTop3: number;
  /** 可用资金（已含本轮 Step 0 全部到账与应扣切换/开城费的剩余） */
  availableBudget: number;
  /** 累计加权得分（赛务排名依据） */
  weightedTotalBefore: number;
  /** 累计有效关注度（展示用） */
  attentionTotalBefore: number;
}

/** 单轮决策（来自参赛端；Step 0 之后的净可用资金 availableBudget 已知）。 */
export interface RoundDecision {
  teamId: string;
  /** 本轮最终路线（可能是切换后的） */
  route: RouteId;
  /** 本轮最终已开通城市（可能新增） */
  openedCities: CityId[];
  /** 本轮全局 Tech 投入（万） */
  investTech: number;
  /** 每城 Fit / Show 投入（万），key 必须是已开通城 */
  investFitByCity: Partial<Record<CityId, number>>;
  investShowByCity: Partial<Record<CityId, number>>;
  /** 产品宣言（≤60 字） */
  declaration: string;
}

/** 本轮整体上下文。 */
export interface SettlementContext {
  roundNo: 1 | 2 | 3 | 4;
  /** R3 才会出现非 "none"；R1/R2/R4 必为 "none" */
  eventId: EventId;
  teams: TeamEngineSnapshot[];
  decisions: RoundDecision[];
  totalTeams: number;
}

/** 每队在每城的结算细节。 */
export interface CitySettlementDetail {
  cityId: CityId;
  /** 本轮新开城标记 */
  justExpanded: boolean;
  invFit: number;
  invShow: number;
  fitRank: number;
  showRank: number;
  kCity: number;
  deltaFit: number;
  deltaShow: number;
  fitAfter: number;
  showAfter: number;
  haloFactor: number;
  /** raw_share = Σ_group p_g · softmaxShare_g */
  rawShare: number;
  rawShareByGroup: Record<GroupId, number>;
  ceiling: number;
  /** slice = rawShare · Ceiling */
  slice: number;
  /** attention_raw = slice · 100 · MarketScale */
  attentionRaw: number;
}

/** 每队结算结果。 */
export interface TeamSettlementResult {
  teamId: string;
  displayName: string;
  productName: string;
  route: RouteId;
  /** 本轮最终 Tech 属性 */
  tech: number;
  deltaTech: number;
  /** 等效投入（技术路线 boost 已计入） */
  techIEff: number;
  /** 原始 Tech 投入（未过载前） */
  techInvestRaw: number;
  fBonus: number;
  mCrowd: number;
  /** 每城明细 */
  cities: Record<CityId, CitySettlementDetail>;
  /** 本轮 Show 三城总增量 */
  sumShowDelta: number;
  /** 跨城汇总 */
  rawAttention: number;
  momentum: number;
  hotpulse: number;
  hotpulseLabel: string | null;
  totalRaw: number;
  /** BQI 细分 */
  bqi: number;
  bqiClipped: boolean;
  bqiContribs: Array<{ rule: string; delta: number; note: string }>;
  noise: number;
  effAttention: number;
  /** 本轮排名 */
  rank: number;
  /** 本轮加权得分（EffAttention × weight） */
  weightedRoundScore: number;
  /** 累计加权得分（本轮结算后） */
  weightedTotal: number;
  /** 累计关注度（本轮结算后） */
  attentionTotal: number;
  /** 宣言关键词命中 */
  declarationHits: {
    tech: string[];
    fit: string[];
    show: string[];
    vision: string[];
  };
  /** 投入占比快照（用于宣言达标判断） */
  investShares: { tech: number; fit: number; show: number };
  /** 本轮计算得的下轮 follow_on */
  followOnNextRound: number;
  /** 与 consecutiveTop3 同步弃用，结算后恒为 0。 */
  consecutiveTop3After: number;
  /** 花费构成 */
  spent: {
    tech: number;
    fit: number;
    show: number;
    switchCost: number;
    expandCost: number;
    total: number;
    reserved: number;
  };

  /** 资金回顾（用于参赛端用“人话”解释钱从哪来、花到哪去） */
  cashflow?: {
    roundNo: number;
    /** 本轮可用上限（Step 0 后） */
    cap: number;
    /** 本轮总支出（含切换/开城费） */
    paid: number;
    /** 本轮结余（cap - paid） */
    reserved: number;
    /** 本轮结余产生的利息（若非末轮） */
    interest: number;
    /** 固定追加（若非末轮） */
    grant: number;
    /** 投资人追加（follow_on，若非末轮） */
    followOn: number;
    /** 进入下一轮的资金余额（reserved + interest + grant + followOn） */
    nextBudget: number;
  };

  /** 路线拥挤度反馈（参赛端展示用，不含具体路线与人数） */
  routeCrowd?: {
    /** 蓝海/正常/拥挤/非常拥挤 */
    level: "blue_ocean" | "normal" | "crowded" | "very_crowded";
    label: "蓝海" | "正常" | "拥挤" | "非常拥挤";
    /** 场上是否存在蓝海路线（人数 ≤ 2）；不透露具体是哪条 */
    hasBlueOceanSomewhere: boolean;
  };
}

/** 结算产出的新闻项（供新闻滚动页使用） */
export interface NewsItem {
  id: string;
  roundNo: number;
  /** 分类便于前端图标/配色 */
  kind:
    | "hot_pulse"
    | "pathfinder_boom"
    | "pathfinder_crowd"
    | "marketing_over"
    | "declaration_win"
    | "declaration_miss"
    | "tech_last"
    | "fit_last"
    | "all_round"
    | "city_debut"
    | "route_switch"
    | "ceiling_boost"
    | "rank_top"
    | "event_r3";
  headline: string;
  body: string;
  /** 相关队伍 id / 显示名（可为多个）；便于大屏/新闻页展示 */
  teamIds: string[];
}

export interface SettlementOutput {
  roundNo: number;
  eventId: EventId;
  eventLabel: string;
  results: TeamSettlementResult[];
  /** 按城汇总本轮的 Ceiling / slice 列表（大屏饼图数据源） */
  cityPies: Array<{
    cityId: CityId;
    ceiling: number;
    marketScale: number;
    kCity: number;
    /** 各队份额（按 raw_share × Ceiling 归一到该城圆桌） */
    slices: Array<{ teamId: string; displayName: string; productName: string; value: number; percent: number }>;
    /** 非关注（1 - ceiling） */
    unmetPercent: number;
  }>;
  news: NewsItem[];
}
