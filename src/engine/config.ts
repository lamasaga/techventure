/**
 * TechVenture v6.0 参数字典
 * 本文件是结算引擎的唯一数值真源；所有公式中的常量均从此导出，禁止在其它位置硬编码。
 */

export type RouteId = "TECH" | "USER" | "BRAND" | "PATHFINDER";
export type CityId = "南京" | "合肥" | "杭州";
export type GroupId = "geek" | "pragmatic" | "trendy";
export type EventId =
  | "none"
  | "pragmaticWave"
  | "geekWave"
  | "trendyWave"
  | "investorBoom"
  | "compliance"
  | "influencerBoom";

export const CITY_IDS: readonly CityId[] = ["南京", "合肥", "杭州"] as const;
export const ROUTE_IDS: readonly RouteId[] = ["TECH", "USER", "BRAND", "PATHFINDER"] as const;
export const GROUP_IDS: readonly GroupId[] = ["geek", "pragmatic", "trendy"] as const;

export const V6 = {
  SEED: 100,
  ROUND_GRANT: 20,
  INTEREST_RATE: 0.15,
  ROUTE_SWITCH_COST: 5,
  CITY_EXPAND_COST: 10,

  BETA: 0.5,
  SIGMA: 0.05,
  ROUNDS: 4,
  N_REF: 16,
  A_INIT: 2.0,
  A_HARD: 12.0,
  BQI_LAST_COUNT: 4,

  ROUND_WEIGHTS: { 1: 0.15, 2: 0.20, 3: 0.25, 4: 0.40 } as Record<number, number>,

  GROWTHRATE: [
    { upto: 2.0, rate: 1.20 },
    { upto: 4.0, rate: 1.08 },
    { upto: 5.5, rate: 0.95 },
    { upto: 7.0, rate: 0.80 },
    { upto: 8.0, rate: 0.60 },
    { upto: 9.0, rate: 0.38 },
    { upto: 9.5, rate: 0.20 },
    { upto: 10.0, rate: 0.10 },
    { upto: 10.5, rate: 0.05 },
    { upto: 12.0, rate: 0.02 },
  ],

  TECH_OVERLOAD_KAPPA: [
    { upto: 20, kappa: 1.00 },
    { upto: 30, kappa: 0.80 },
    { upto: 45, kappa: 0.50 },
    { upto: 65, kappa: 0.30 },
    { upto: Infinity, kappa: 0.15 },
  ],

  FIT_WEIGHTS: { investment: 0.50, rank: 0.50 },
  SHOW_WEIGHTS: { investment: 0.10, rank: 0.90 },
  SHOW_B_MAX: 2.5,
  FIT_GROWTH_SCALE: 2.0,
  SHOW_HALO: { weight: 0.10 },

  FIT_T1: 5.0,
  FIT_T2: 7.5,
  FIT_T1_BONUS: 0.05,
  FIT_T2_BONUS: 0.08,

  ROUTE_CROWD_UTILITY: {
    TECH: { geek: 0.20, pragmatic: 0.12, trendy: 0.25 },
    USER: { geek: 0.20, pragmatic: 0.12, trendy: 0.25 },
    BRAND: { geek: 0.20, pragmatic: 0.12, trendy: 0.25 },
    PATHFINDER: { geek: 0.10, pragmatic: 0.10, trendy: 0.10 },
  } as Record<RouteId, Record<GroupId, number>>,

  CEILING_CITY: {
    baseConst: 0.10,
    qCoeff: 0.10,
    cap: 0.95,
    maturityMin: 0.70,
    maturityRange: 0.30,
    crowdLift: 0.10,
    showLift: 0.18,
    showLiftRef: 30,
  },

  BQI_RULES: {
    techLastThird: -0.10,
    fitLastThird: -0.10,
    marketingOver: -0.15,
    allRound: +0.12,
    declarationDirectionBase: +0.04,
    declarationDirectionDouble: +0.06,
    declarationDirectionTriple: +0.09,
    declarationVisionBonus: +0.03,
    declarationRewardCap: +0.10,
    declarationDeviationMinor: -0.03,
    floor: 0.60,
    ceil: 1.20,
  },

  MOMENTUM: { decay: 0.40, r1: 0.60, r2: 0.30, r3: 0.10 },

  HOT_PULSE: {
    eligibleRoutes: ["BRAND"] as readonly RouteId[],
    tiers: [
      { threshold: 0.5, bonus: 0.5, label: "上了本地热搜" },
      { threshold: 1.5, bonus: 1.2, label: "登上全国热榜" },
      { threshold: 2.5, bonus: 2.0, label: "现象级爆款全网刷屏" },
      { threshold: 4.5, bonus: 2.5, label: "超级爆款连续霸榜" },
    ],
  },

  CITIES: {
    南京: { scale: 1.00, etaFit: 1.10, etaShow: 0.90, tauTech: 0.85, geek: 0.12, prag: 0.58, trend: 0.30, label: "南京市 · 区域中心" },
    合肥: { scale: 0.85, etaFit: 0.90, etaShow: 1.15, tauTech: 0.90, geek: 0.18, prag: 0.30, trend: 0.52, label: "合肥市 · 网红金融" },
    杭州: { scale: 1.15, etaFit: 1.00, etaShow: 1.00, tauTech: 1.00, geek: 0.25, prag: 0.42, trend: 0.33, label: "杭州市 · 科技中心" },
  } as Record<CityId, { scale: number; etaFit: number; etaShow: number; tauTech: number; geek: number; prag: number; trend: number; label: string }>,

  CONSUMER_WEIGHTS: {
    geek: { tech: 0.55, fit: 0.30, show: 0.15 },
    pragmatic: { tech: 0.22, fit: 0.60, show: 0.18 },
    trendy: { tech: 0.18, fit: 0.22, show: 0.60 },
  } as Record<GroupId, { tech: number; fit: number; show: number }>,

  ROUTES: {
    TECH: {
      label: "技术驱动型",
      tagline: "埋头研发 · 技术为本",
      rTech: 1.25,
      rFit: 1.00,
      rShow: 1.00,
      techInvestBoost: 1.30,
    },
    USER: {
      label: "用户深耕型",
      tagline: "听懂用户 · 精准击中",
      rTech: 1.00,
      rFit: 1.20,
      rShow: 1.00,
      fitT1: 4.5,
      fitT2: 6.5,
    },
    BRAND: {
      label: "品牌传播型",
      tagline: "品牌起势 · 声量登顶",
      rTech: 1.00,
      rFit: 1.00,
      rShow: 1.25,
      canTriggerHotPulse: true,
    },
    PATHFINDER: {
      label: "破局奇兵",
      tagline: "小众路线 · 独占红利",
      rTech: 1.00,
      rFit: 1.00,
      rShow: 1.00,
      crowdCurve: { 1: 1.285, 2: 1.200, 3: 0.80, 4: 0.70, 5: 0.60, 6: 0.50, 8: 0.40, 12: 0.30 } as Record<number, number>,
    },
  } as Record<RouteId, {
    label: string;
    tagline: string;
    rTech: number;
    rFit: number;
    rShow: number;
    techInvestBoost?: number;
    fitT1?: number;
    fitT2?: number;
    canTriggerHotPulse?: boolean;
    crowdCurve?: Record<number, number>;
  }>,

  FOLLOW_ON: {
    maxBase: 15,
    consecutive2Decay: -3,
    consecutive3Decay: -5,
    floor: 3,
  },

  DECLARATION_KEYWORDS: {
    tech: ["技术", "研发", "算法", "性能", "功能", "升级", "核心", "突破", "创新", "工程", "架构", "智能", "模型", "传感", "精度"],
    fit: ["用户", "调研", "需求", "体验", "交互", "实用", "场景", "痛点", "人性化", "反馈", "问卷", "贴心", "易用", "陪伴", "定制"],
    show: ["展示", "设计", "外观", "包装", "品牌", "故事", "营销", "传播", "颜值", "视觉", "风格", "形象", "叙事", "口碑", "推广"],
    vision: ["愿景", "使命", "改变", "未来", "梦想", "初心", "解决", "普惠", "赋能", "创业", "坚持", "迭代", "挑战", "成长", "学习", "探索", "勇气", "信任", "责任", "公平", "环保", "可持续", "守护", "关怀", "温度", "真诚"],
  },
  DECLARATION_MIN_INVESTMENT: { tech: 0.30, fit: 0.25, show: 0.20 },
  DECLARATION_DEVIATION_THRESHOLD_PP: 0.25,

  EVENTS: [
    { id: "none", label: "无事件", desc: "平稳回合，市场无特殊变化。" },
    { id: "pragmaticWave", label: "用户口味大变", desc: "三城 Pragmatic 群体占比 +10pp，用户匹配身价暴涨。" },
    { id: "geekWave", label: "技术突破浪潮", desc: "三城 Geek 群体占比 +15pp，技术力成为焦点。" },
    { id: "trendyWave", label: "社交媒体爆发", desc: "三城 Trendy 群体占比 +10pp，展示力话题连天。" },
    { id: "investorBoom", label: "投资狂潮", desc: "全场投资热情飙升：所有队伍额外获得 30 万追加投资（R3 结算后到账）。" },
    { id: "compliance", label: "政策合规", desc: "营销过度罚则 ×1.5，品牌过火者被加倍打击。" },
    { id: "influencerBoom", label: "网红崛起", desc: "合肥市场规模 0.85 → 1.10，潮流之城含金量飙升。" },
  ] as Array<{ id: EventId; label: string; desc: string }>,
} as const;

export type V6Params = typeof V6;

/** I_eff(I)：Tech 过载系数 κ(x) 的分段积分。 */
export function techIEff(I: number): number {
  const i = Math.max(0, I);
  if (i <= 20) return i;
  if (i <= 30) return 20 + 0.80 * (i - 20);
  if (i <= 45) return 28 + 0.50 * (i - 30);
  if (i <= 65) return 35.5 + 0.30 * (i - 45);
  return 41.5 + 0.15 * (i - 65);
}

/** 过载段（供提示） */
export function techOverloadTier(I: number): { upto: number; kappa: number; label: string } {
  const i = Math.max(0, I);
  if (i <= 20) return { upto: 20, kappa: 1.0, label: "节奏正常" };
  if (i <= 30) return { upto: 30, kappa: 0.8, label: "开始吃力" };
  if (i <= 45) return { upto: 45, kappa: 0.5, label: "瓶颈显现" };
  if (i <= 65) return { upto: 65, kappa: 0.3, label: "性价比极差" };
  return { upto: Infinity, kappa: 0.15, label: "资金严重空转" };
}

/** growthrate g(V) */
export function growthRate(V: number): number {
  for (const seg of V6.GROWTHRATE) {
    if (V <= seg.upto) return seg.rate;
  }
  return 0.02;
}

/** PATHFINDER 独占红利曲线：相邻档线性插值 */
export function pathfinderMCrowd(n: number): number {
  const curve = V6.ROUTES.PATHFINDER.crowdCurve!;
  const keys = Object.keys(curve).map((k) => Number(k)).sort((a, b) => a - b);
  if (n <= keys[0]) return curve[keys[0]];
  if (n >= keys[keys.length - 1]) return curve[keys[keys.length - 1]];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (n >= a && n <= b) {
      const t = (n - a) / (b - a);
      return curve[a] + t * (curve[b] - curve[a]);
    }
  }
  return 1.0;
}

/** 数值约束：将浮点数裁到 [lo, hi] */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** 1 位小数（万元金额通用） */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** 2 位小数（属性通用） */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
