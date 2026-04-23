/**
 * TechVenture v6.0 结算引擎主函数。
 * 与 v6.0 核心公式文档 Step 0 ~ Step 9 严格对齐；仅消费 contracts.ts 中定义的类型。
 */

import {
  V6,
  CITY_IDS,
  GROUP_IDS,
  clamp,
  growthRate,
  pathfinderMCrowd,
  round1,
  round2,
  techIEff,
  type CityId,
  type EventId,
  type GroupId,
  type RouteId,
} from "./config.js";
import type {
  CitySettlementDetail,
  NewsItem,
  RoundDecision,
  SettlementContext,
  SettlementOutput,
  TeamEngineSnapshot,
  TeamSettlementResult,
} from "./contracts.js";

/** 2 位小数（内部计算尾数） */
const r2 = round2;
/** 1 位小数 */
const r1 = round1;

/** 稳定 FNV-1a 哈希：同种子 → 同文案变体，便于重放一致 */
function hash32s(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** 同类型快讯两种叙述选其一 */
function say2(seed: string, a: string, b: string): string {
  return hash32s(seed) % 2 === 0 ? a : b;
}
function eventR3Narrative(eventId: EventId, desc: string, roundNo: number): string {
  const seed = `ev-${eventId}-r${roundNo}`;
  switch (eventId) {
    case "pragmaticWave":
      return say2(
        seed,
        "三城用户口味更偏实用，体验与落地能力正在升值。",
        "市场审美更稳健，会讲故事不如把产品做出手感与确定性。",
      );
    case "geekWave":
      return say2(
        seed,
        "极客与参数党抬头，技术底色的对撞比上一回合更直接。",
        "硬核叙事占据主动权，会亮指标、敢对打的队伍更有舞台。",
      );
    case "trendyWave":
      return say2(
        seed,
        "社媒与情绪传播更快，展示与声量比往常更容易出圈。",
        "潮向话题更密，会抓热点的品牌更容易被看见、被转述。",
      );
    case "investorBoom":
      return say2(
        seed,
        "资本端情绪转暖，后续到账的追加投资预期更厚。",
        "投资人更愿意给支票，为下一阶段留足弹药与底气。",
      );
    case "compliance":
      return say2(
        seed,
        "监管与合规模块被反复提及，对“高曝光、弱产品”的容忍在下降。",
        "营销尺度被放大检视，过火者更容易被拿来做镜鉴。",
      );
    case "influencerBoom":
      return say2(
        seed,
        "区域网红与潮流注意力升温，部分城市的水位在结构性重塑。",
        "流量与话题向热点城市与腰部达人倾斜，地理红利在切换。",
      );
    case "none":
      return desc;
    default:
      return say2(seed, desc, "赛场出现新的外生扰动，各队需跟着节奏重排优先级。");
  }
}

function buildCityShift(eventId: EventId): Partial<Record<GroupId, number>> {
  if (eventId === "pragmaticWave") return { pragmatic: +0.10 };
  if (eventId === "geekWave") return { geek: +0.15 };
  if (eventId === "trendyWave") return { trendy: +0.10 };
  return {};
}

function applyGroupShift(
  base: { geek: number; prag: number; trend: number },
  shift: Partial<Record<GroupId, number>>,
): Record<GroupId, number> {
  const mapped: Record<GroupId, number> = {
    geek: base.geek,
    pragmatic: base.prag,
    trendy: base.trend,
  };
  let add = 0;
  for (const k of GROUP_IDS) {
    const d = shift[k] ?? 0;
    add += d;
    mapped[k] += d;
  }
  if (add === 0) return mapped;
  // 其他未增加群体按原比例瓜分 -add
  const others = GROUP_IDS.filter((g) => (shift[g] ?? 0) === 0);
  const sumOthers = others.reduce((s, g) => s + mapped[g], 0);
  if (sumOthers <= 0) return mapped;
  for (const g of others) {
    mapped[g] = mapped[g] - (mapped[g] / sumOthers) * add;
  }
  return {
    geek: clamp(mapped.geek, 0, 1),
    pragmatic: clamp(mapped.pragmatic, 0, 1),
    trendy: clamp(mapped.trendy, 0, 1),
  };
}

function getCityMarketScale(cityId: CityId, eventId: EventId): number {
  if (eventId === "influencerBoom" && cityId === "合肥") return 1.10;
  return V6.CITIES[cityId].scale;
}

function softmax(beta: number, utilities: Record<string, number>): Record<string, number> {
  const ids = Object.keys(utilities);
  if (ids.length === 0) return {};
  const maxU = Math.max(...ids.map((id) => utilities[id]));
  let sum = 0;
  const exp: Record<string, number> = {};
  for (const id of ids) {
    const e = Math.exp(beta * (utilities[id] - maxU));
    exp[id] = e;
    sum += e;
  }
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = sum > 0 ? exp[id] / sum : 1 / ids.length;
  return out;
}

function rankDesc(values: Array<{ id: string; v: number }>): Map<string, number> {
  const sorted = [...values].sort((a, b) => b.v - a.v);
  const rankMap = new Map<string, number>();
  sorted.forEach((x, i) => rankMap.set(x.id, i + 1));
  return rankMap;
}

function boundedRankInCity(
  rankMap: Map<string, number>,
  teamId: string,
  kCity: number,
): { r: number; bFit: number; bShow: number } {
  const r = rankMap.get(teamId) ?? kCity;
  const bFit = Math.max(0, 1 - (r - 1) / Math.max(1, kCity));
  const S = V6.SHOW_B_MAX;
  const bShow = Math.max(0, S - S * ((r - 1) / Math.max(1, kCity)));
  return { r, bFit, bShow };
}

function fitThresholdBonusSum(route: RouteId, fitByCity: Record<CityId, number>, openedCities: CityId[]): number {
  let sum = 0;
  const t1 = route === "USER" ? V6.ROUTES.USER.fitT1! : V6.FIT_T1;
  const t2 = route === "USER" ? V6.ROUTES.USER.fitT2! : V6.FIT_T2;
  for (const c of openedCities) {
    const v = fitByCity[c] ?? V6.A_INIT;
    if (v >= t2) sum += V6.FIT_T2_BONUS;
    else if (v >= t1) sum += V6.FIT_T1_BONUS;
  }
  return sum;
}

function detectHits(declaration: string): Record<"tech" | "fit" | "show" | "vision", string[]> {
  const text = (declaration || "").trim();
  const out = { tech: [] as string[], fit: [] as string[], show: [] as string[], vision: [] as string[] };
  if (!text) return out;
  for (const k of V6.DECLARATION_KEYWORDS.tech) if (text.includes(k)) out.tech.push(k);
  for (const k of V6.DECLARATION_KEYWORDS.fit) if (text.includes(k)) out.fit.push(k);
  for (const k of V6.DECLARATION_KEYWORDS.show) if (text.includes(k)) out.show.push(k);
  for (const k of V6.DECLARATION_KEYWORDS.vision) if (text.includes(k)) out.vision.push(k);
  return out;
}

function computeInvestShares(invTech: number, sumFit: number, sumShow: number): { tech: number; fit: number; show: number; total: number } {
  const total = invTech + sumFit + sumShow;
  if (total <= 0) return { tech: 0, fit: 0, show: 0, total: 0 };
  return {
    tech: invTech / total,
    fit: sumFit / total,
    show: sumShow / total,
    total,
  };
}

function noiseSample(): number {
  return (Math.random() * 2 - 1) * V6.SIGMA;
}

function crowdLevelOf(n: number): { level: "blue_ocean" | "normal" | "crowded" | "very_crowded"; label: "蓝海" | "正常" | "拥挤" | "非常拥挤" } {
  // 参赛端口径：只给 4 档强度，不给人数/阈值细节
  if (n <= 2) return { level: "blue_ocean", label: "蓝海" };
  if (n <= 4) return { level: "normal", label: "正常" };
  if (n <= 6) return { level: "crowded", label: "拥挤" };
  return { level: "very_crowded", label: "非常拥挤" };
}

/** 主入口 */
export function settleRoundV6(ctx: SettlementContext): SettlementOutput {
  const { roundNo, eventId, teams, decisions } = ctx;
  const N = Math.max(ctx.totalTeams, teams.length);
  const decMap = new Map<string, RoundDecision>();
  for (const d of decisions) decMap.set(d.teamId, d);

  // —— 路线计数（用于 Step 3 M_crowd 与 Step 4 crowd tax）
  const routeCount: Record<RouteId, number> = { TECH: 0, USER: 0, BRAND: 0, PATHFINDER: 0 };
  for (const t of teams) {
    const d = decMap.get(t.id);
    const route = d?.route ?? t.route;
    routeCount[route] += 1;
  }
  const hasBlueOceanSomewhere = Object.values(routeCount).some((n) => n <= 2);

  // —— 全场 Tech 投入排名（BQI R1 Tech 末位）
  const techInvests = teams.map((t) => ({ id: t.id, v: decMap.get(t.id)?.investTech ?? 0 }));
  const techInvestRankMap = rankDesc(techInvests);

  // —— 全场 Fit 总投入排名（BQI R2）
  const fitInvestSumById: Record<string, number> = {};
  for (const t of teams) {
    const d = decMap.get(t.id);
    let s = 0;
    if (d) {
      for (const c of CITY_IDS) s += d.investFitByCity[c] ?? 0;
    }
    fitInvestSumById[t.id] = s;
  }
  const fitInvestRankMap = rankDesc(
    teams.map((t) => ({ id: t.id, v: fitInvestSumById[t.id] })),
  );

  // —— 同城投入排名（Step 2）
  const fitRankByCity: Partial<Record<CityId, Map<string, number>>> = {};
  const showRankByCity: Partial<Record<CityId, Map<string, number>>> = {};
  const fitRankKByCity: Partial<Record<CityId, number>> = {};
  const showRankKByCity: Partial<Record<CityId, number>> = {};
  const teamsByCity: Partial<Record<CityId, string[]>> = {};
  for (const c of CITY_IDS) {
    const arr: Array<{ id: string; v: number }> = [];
    const arrShow: Array<{ id: string; v: number }> = [];
    const opened: string[] = [];
    for (const t of teams) {
      const d = decMap.get(t.id);
      const oc = d?.openedCities ?? t.openedCities;
      if (!oc.includes(c)) continue;
      opened.push(t.id);
      // 规则：只有“本回合在该城投了钱”的队伍，才参与该城该项排名并获得排名加成
      const invF = d?.investFitByCity[c] ?? 0;
      const invS = d?.investShowByCity[c] ?? 0;
      if (invF > 0) arr.push({ id: t.id, v: invF });
      if (invS > 0) arrShow.push({ id: t.id, v: invS });
    }
    fitRankByCity[c] = rankDesc(arr);
    showRankByCity[c] = rankDesc(arrShow);
    fitRankKByCity[c] = arr.length;
    showRankKByCity[c] = arrShow.length;
    teamsByCity[c] = opened;
  }

  // —— 临时：每队每城属性增长后 + Show 投入（用于 Step 6 showLift / Ceiling）
  type TeamWork = {
    snap: TeamEngineSnapshot;
    dec: RoundDecision;
    route: RouteId;
    techAfter: number;
    deltaTech: number;
    techIEffVal: number;
    fBonus: number;
    mCrowd: number;
    fitAfter: Record<CityId, number>;
    showAfter: Record<CityId, number>;
    deltaFit: Record<CityId, number>;
    deltaShow: Record<CityId, number>;
    haloFactor: Record<CityId, number>;
    invFit: Record<CityId, number>;
    invShow: Record<CityId, number>;
    fitRankInCity: Record<CityId, number>;
    showRankInCity: Record<CityId, number>;
    justExpandedCities: CityId[];
    openedCities: CityId[];
  };

  const works: TeamWork[] = [];

  for (const t of teams) {
    const d = decMap.get(t.id);
    const dec: RoundDecision =
      d ??
      {
        teamId: t.id,
        route: t.route,
        openedCities: [...t.openedCities],
        investTech: 0,
        investFitByCity: {},
        investShowByCity: {},
        declaration: "",
      };

    const route = dec.route;
    const openedCities = dec.openedCities.slice();

    // Step 3 —— Tech 增长
    const rTech = V6.ROUTES[route].rTech;
    const boost = V6.ROUTES[route].techInvestBoost ?? 1.0;
    const iTechRaw = Math.max(0, dec.investTech);
    const iTechBoosted = iTechRaw * boost;
    const iTechEff = techIEff(iTechBoosted);
    const fBonus = 1 + fitThresholdBonusSum(route, t.fitByCity, openedCities);
    const mCrowd = route === "PATHFINDER" ? pathfinderMCrowd(routeCount.PATHFINDER) : 1.0;
    const gTech = growthRate(t.tech);
    const deltaTech = gTech * Math.sqrt(iTechEff / 10) * rTech * mCrowd * fBonus;
    const techAfter = clamp(t.tech + deltaTech, 0, V6.A_HARD);

    // 跨城 halo 用本队当前 Show 最大值
    const showMax = Math.max(V6.A_INIT, ...CITY_IDS.map((c) => t.showByCity[c] ?? V6.A_INIT));

    const fitAfter: Record<CityId, number> = { 南京: V6.A_INIT, 合肥: V6.A_INIT, 杭州: V6.A_INIT };
    const showAfter: Record<CityId, number> = { 南京: V6.A_INIT, 合肥: V6.A_INIT, 杭州: V6.A_INIT };
    const deltaFit: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
    const deltaShow: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
    const haloFactor: Record<CityId, number> = { 南京: 1, 合肥: 1, 杭州: 1 };
    const invFit: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
    const invShow: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
    const fitRankInCity: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
    const showRankInCity: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };

    for (const c of CITY_IDS) {
      const currFit = t.fitByCity[c] ?? V6.A_INIT;
      const currShow = t.showByCity[c] ?? V6.A_INIT;
      fitAfter[c] = currFit;
      showAfter[c] = currShow;
      if (!openedCities.includes(c)) continue;
      const kCity = teamsByCity[c]!.length;

      const invF = Math.max(0, dec.investFitByCity[c] ?? 0);
      const invS = Math.max(0, dec.investShowByCity[c] ?? 0);
      invFit[c] = invF;
      invShow[c] = invS;

      // 仅当该城该项本回合有投入时，才参与排名并获得排名加成；否则加成为 0，排名显示为 0（前端显示为 “—”）
      const kFitRank = fitRankKByCity[c] ?? 0;
      const kShowRank = showRankKByCity[c] ?? 0;
      const fitRank = invF > 0 ? (fitRankByCity[c]!.get(t.id) ?? kFitRank) : 0;
      const showRank = invS > 0 ? (showRankByCity[c]!.get(t.id) ?? kShowRank) : 0;
      fitRankInCity[c] = fitRank;
      showRankInCity[c] = showRank;
      const bFit = invF > 0 && kFitRank > 0 ? boundedRankInCity(fitRankByCity[c]!, t.id, kFitRank).bFit : 0;
      const bShowInCity = invS > 0 && kShowRank > 0 ? boundedRankInCity(showRankByCity[c]!, t.id, kShowRank).bShow : 0;

      // Fit 城市增长
      const gFit = growthRate(currFit);
      const rFit = V6.ROUTES[route].rFit;
      const etaFit = V6.CITIES[c].etaFit;
      const dFit =
        gFit *
        (V6.FIT_WEIGHTS.investment * Math.sqrt(invF / 10) + V6.FIT_WEIGHTS.rank * bFit) *
        rFit *
        mCrowd *
        etaFit *
        V6.FIT_GROWTH_SCALE;

      // Show 城市增长（halo 使用本队全局 Show 最大值作为参考）
      const haloDelta = showMax > 0 ? clamp((showMax - currShow) / showMax, 0, 1) : 0;
      const halo = 1 + V6.SHOW_HALO.weight * haloDelta;
      haloFactor[c] = halo;
      const gShow = growthRate(currShow);
      const rShow = V6.ROUTES[route].rShow;
      const etaShow = V6.CITIES[c].etaShow;
      const dShow =
        gShow *
        (V6.SHOW_WEIGHTS.rank * bShowInCity + V6.SHOW_WEIGHTS.investment * Math.sqrt(invS / 5)) *
        halo *
        rShow *
        mCrowd *
        etaShow;

      deltaFit[c] = dFit;
      deltaShow[c] = dShow;
      fitAfter[c] = clamp(currFit + dFit, 0, V6.A_HARD);
      showAfter[c] = clamp(currShow + dShow, 0, V6.A_HARD);
    }

    const justExpandedCities = openedCities.filter((c) => !t.openedCities.includes(c));

    works.push({
      snap: t,
      dec,
      route,
      techAfter,
      deltaTech,
      techIEffVal: iTechEff,
      fBonus,
      mCrowd,
      fitAfter,
      showAfter,
      deltaFit,
      deltaShow,
      haloFactor,
      invFit,
      invShow,
      fitRankInCity,
      showRankInCity,
      justExpandedCities,
      openedCities,
    });
  }

  // —— Step 4~6：城市份额、Ceiling、attention_raw
  const cityPies: SettlementOutput["cityPies"] = [];
  // 队伍 → 跨城 attention_raw 汇总
  const rawAttentionByTeam: Record<string, number> = {};
  const citiesDetailByTeam: Record<string, Record<CityId, CitySettlementDetail>> = {};
  for (const w of works) {
    rawAttentionByTeam[w.snap.id] = 0;
    citiesDetailByTeam[w.snap.id] = {
      南京: emptyCityDetail("南京"),
      合肥: emptyCityDetail("合肥"),
      杭州: emptyCityDetail("杭州"),
    };
  }

  for (const c of CITY_IDS) {
    const opened = teamsByCity[c]!;
    if (opened.length === 0) {
      cityPies.push({
        cityId: c,
        ceiling: 0,
        marketScale: getCityMarketScale(c, eventId),
        kCity: 0,
        slices: [],
        unmetPercent: 1,
      });
      continue;
    }
    const kCity = opened.length;

    // 群体占比（可能被 R3 事件改写）
    const baseGroup = V6.CITIES[c];
    const groupShares = applyGroupShift(baseGroup, buildCityShift(eventId));

    // 每群体 softmax
    const rawShareByTeam: Record<string, number> = {};
    const rawShareByTeamByGroup: Record<string, Record<GroupId, number>> = {};
    for (const id of opened) {
      rawShareByTeam[id] = 0;
      rawShareByTeamByGroup[id] = { geek: 0, pragmatic: 0, trendy: 0 };
    }

    for (const group of GROUP_IDS) {
      const cw = V6.CONSUMER_WEIGHTS[group];
      const utilities: Record<string, number> = {};
      for (const id of opened) {
        const w = works.find((x) => x.snap.id === id)!;
        const route = w.route;
        const tauTech = V6.CITIES[c].tauTech;
        const techAdj = w.techAfter * tauTech;
        const baseU = cw.tech * techAdj + cw.fit * w.fitAfter[c] + cw.show * w.showAfter[c];
        const crowdTaxW = V6.ROUTE_CROWD_UTILITY[route][group];
        const crowdTax = Math.max(0, 1 - crowdTaxW * ((routeCount[route] - 1) / Math.max(1, N - 1)));
        utilities[id] = baseU * crowdTax;
      }
      const s = softmax(V6.BETA, utilities);
      for (const id of opened) {
        rawShareByTeamByGroup[id][group] = s[id];
        rawShareByTeam[id] += groupShares[group] * s[id];
      }
    }

    // Ceiling_c
    const avgQ =
      opened
        .map((id) => {
          const w = works.find((x) => x.snap.id === id)!;
          return (w.techAfter + w.fitAfter[c] + w.showAfter[c]) / 3;
        })
        .reduce((a, b) => a + b, 0) / kCity;
    const sumShow = opened
      .map((id) => works.find((x) => x.snap.id === id)!.invShow[c])
      .reduce((a, b) => a + b, 0);
    const P = V6.CEILING_CITY;
    const base = P.baseConst + P.qCoeff * avgQ;
    const maturity = P.maturityMin + P.maturityRange * ((kCity - 1) / Math.max(1, N - 1));
    const crowdLift = P.crowdLift * ((kCity - 1) / Math.max(1, N - 1));
    const showLift = P.showLift * (1 - Math.exp(-sumShow / P.showLiftRef));
    const ceiling = Math.min(P.cap, base * maturity + crowdLift + showLift);

    const marketScale = getCityMarketScale(c, eventId);

    const slices: SettlementOutput["cityPies"][number]["slices"] = [];
    for (const id of opened) {
      const w = works.find((x) => x.snap.id === id)!;
      const raw = rawShareByTeam[id];
      const slice = raw * ceiling;
      const attentionRaw = slice * 100 * marketScale;
      rawAttentionByTeam[id] += attentionRaw;

      const detail: CitySettlementDetail = {
        cityId: c,
        justExpanded: w.justExpandedCities.includes(c),
        invFit: w.invFit[c],
        invShow: w.invShow[c],
        fitRank: w.fitRankInCity[c],
        showRank: w.showRankInCity[c],
        kCity,
        deltaFit: w.deltaFit[c],
        deltaShow: w.deltaShow[c],
        fitAfter: w.fitAfter[c],
        showAfter: w.showAfter[c],
        haloFactor: w.haloFactor[c],
        rawShare: raw,
        rawShareByGroup: rawShareByTeamByGroup[id],
        ceiling,
        slice,
        attentionRaw,
      };
      citiesDetailByTeam[id][c] = detail;
      slices.push({
        teamId: id,
        displayName: w.snap.displayName,
        productName: w.snap.productName,
        value: slice,
        percent: slice, // 已是占饼图比例（raw_share × ceiling）
      });
    }

    cityPies.push({
      cityId: c,
      ceiling,
      marketScale,
      kCity,
      slices,
      unmetPercent: 1 - ceiling,
    });
  }

  // —— Step 7：momentum、hotpulse、totalRaw
  const momentumBase: Record<number, number> = { 1: V6.MOMENTUM.r1, 2: V6.MOMENTUM.r2, 3: V6.MOMENTUM.r3 };

  const totalRawByTeam: Record<string, number> = {};
  const momentumByTeam: Record<string, number> = {};
  const hotpulseByTeam: Record<string, number> = {};
  const hotpulseLabelByTeam: Record<string, string | null> = {};

  for (const w of works) {
    const sumShowDelta = CITY_IDS.reduce((s, c) => s + w.deltaShow[c], 0);
    let hotpulse = 0;
    let hotpulseLabel: string | null = null;
    if (roundNo >= 1 && V6.ROUTES[w.route].canTriggerHotPulse) {
      for (const tier of V6.HOT_PULSE.tiers) {
        if (sumShowDelta >= tier.threshold) {
          hotpulse = tier.bonus;
          hotpulseLabel = tier.label;
        }
      }
    }
    const mom =
      roundNo === 1
        ? 0
        : V6.MOMENTUM.decay * (momentumBase[w.snap.lastRank ?? 99] ?? 0);
    momentumByTeam[w.snap.id] = mom;
    hotpulseByTeam[w.snap.id] = hotpulse;
    hotpulseLabelByTeam[w.snap.id] = hotpulseLabel;
    totalRawByTeam[w.snap.id] = rawAttentionByTeam[w.snap.id] + mom + hotpulse;
  }

  // —— Step 8：BQI + noise → EffAttention
  // 准备 BQI 所需的全场统计
  const techRankMap = rankDesc(works.map((w) => ({ id: w.snap.id, v: w.techAfter })));
  const fitSumByTeam: Record<string, number> = {};
  const showSumByTeam: Record<string, number> = {};
  for (const w of works) {
    fitSumByTeam[w.snap.id] = CITY_IDS.reduce((s, c) => s + w.fitAfter[c], 0);
    showSumByTeam[w.snap.id] = CITY_IDS.reduce((s, c) => s + w.showAfter[c], 0);
  }
  const fitSumRankMap = rankDesc(works.map((w) => ({ id: w.snap.id, v: fitSumByTeam[w.snap.id] })));
  const showSumRankMap = rankDesc(works.map((w) => ({ id: w.snap.id, v: showSumByTeam[w.snap.id] })));

  // 每城 Show 属性排名（用于 marketingOver）
  const cityShowRank: Record<CityId, Map<string, number>> = {
    南京: new Map(),
    合肥: new Map(),
    杭州: new Map(),
  };
  for (const c of CITY_IDS) {
    cityShowRank[c] = rankDesc(works.map((w) => ({ id: w.snap.id, v: w.showAfter[c] })));
  }

  // 末位名单（固定 4 名）
  const BL = V6.BQI_LAST_COUNT;
  const tailTechIds = [...works]
    .sort((a, b) => a.techAfter - b.techAfter)
    .slice(0, Math.min(BL, works.length))
    .map((w) => w.snap.id);
  const tailFitInvestIds = [...works]
    .sort((a, b) => (fitInvestSumById[a.snap.id] ?? 0) - (fitInvestSumById[b.snap.id] ?? 0))
    .slice(0, Math.min(BL, works.length))
    .map((w) => w.snap.id);

  // 头部 1/3（R4 allRound）
  const topCut = Math.max(1, Math.ceil(works.length / 3));
  const topTechSet = new Set([...works].sort((a, b) => b.techAfter - a.techAfter).slice(0, topCut).map((w) => w.snap.id));
  const topFitSet = new Set([...works].sort((a, b) => fitSumByTeam[b.snap.id] - fitSumByTeam[a.snap.id]).slice(0, topCut).map((w) => w.snap.id));
  const topShowSet = new Set([...works].sort((a, b) => showSumByTeam[b.snap.id] - showSumByTeam[a.snap.id]).slice(0, topCut).map((w) => w.snap.id));

  const news: NewsItem[] = [];
  const pushNews = (item: Omit<NewsItem, "id"> & { id?: string }) => {
    news.push({
      id: item.id ?? `r${item.roundNo}-${item.kind}-${news.length}`,
      roundNo: item.roundNo,
      kind: item.kind,
      headline: item.headline,
      body: item.body,
      teamIds: item.teamIds,
    });
  };

  const results: TeamSettlementResult[] = [];

  for (const w of works) {
    const bqiContribs: Array<{ rule: string; delta: number; note: string }> = [];

    // R1 Tech 末位惩罚
    if (tailTechIds.includes(w.snap.id)) {
      bqiContribs.push({
        rule: "techLastThird",
        delta: V6.BQI_RULES.techLastThird,
        note: "技术力排名处于全场最末 4 位，市场怀疑你们的技术成熟度。",
      });
    }
    // R2 Fit 投入末位
    if (tailFitInvestIds.includes(w.snap.id)) {
      bqiContribs.push({
        rule: "fitLastThird",
        delta: V6.BQI_RULES.fitLastThird,
        note: "全场用户调研投入处于最末 4 位，用户觉得你们没听懂他们要什么。",
      });
    }
    // R3 营销过度反噬
    const maxCity = [...CITY_IDS].sort((a, b) => w.showAfter[b] - w.showAfter[a])[0];
    const maxCityShow = w.showAfter[maxCity];
    const otherMax = Math.max(...works.filter((x) => x.snap.id !== w.snap.id).map((x) => x.showAfter[maxCity]));
    const isMarketingOver =
      maxCityShow >= otherMax - 0.5 && maxCityShow > w.techAfter + 2;
    if (isMarketingOver) {
      const isCompliance = eventId === "compliance";
      const delta = V6.BQI_RULES.marketingOver * (isCompliance ? 1.5 : 1);
      bqiContribs.push({
        rule: "marketingOver",
        delta,
        note: `${maxCity}市一枝独秀刷屏（Show ${r2(maxCityShow)}），且远超自家技术盘（Tech ${r2(w.techAfter)}）。${isCompliance ? "政策合规监管加倍处罚。" : ""}`,
      });
      pushNews({
        roundNo,
        kind: "marketing_over",
        headline: `【${w.snap.displayName}】${maxCity}市投放过火 遭监管点名`,
        body: say2(
          `mo-${w.snap.id}-${roundNo}`,
          isCompliance
            ? `《${w.snap.productName}》在${maxCity}声量起得过猛，而技术盘显得托不住；合规模块里质疑被同步放大。`
            : `《${w.snap.productName}》在${maxCity}展示端很抢眼，与研发底色拉出距离，现场讨论更谨慎。`,
          isCompliance
            ? `《${w.snap.productName}》在${maxCity}市场曝光过量，与产品内功不够匹配，被点名并非偶然。`
            : `《${w.snap.productName}》在${maxCity}形成“高曝光、低后坐力”的观感，用户开始追问产品力。`,
        ),
        teamIds: [w.snap.id],
      });
    }

    // R4 实力派
    if (topTechSet.has(w.snap.id) && topFitSet.has(w.snap.id) && topShowSet.has(w.snap.id)) {
      bqiContribs.push({
        rule: "allRound",
        delta: V6.BQI_RULES.allRound,
        note: "三项指标均进入前 1/3，稳扎稳打的口碑正在形成。",
      });
      pushNews({
        roundNo,
        kind: "all_round",
        headline: `【${w.snap.displayName}】三项全能 实力派口碑持续扩散`,
        body: say2(
          `ar-${w.snap.id}-${roundNo}`,
          `三指标同时站在上游区，《${w.snap.productName}》更像能打的“全垒手”型项目。`,
          `《${w.snap.productName}》在技术、匹配与声量上更均衡，本回合给现场留下“稳扎稳打”的观感。`,
        ),
        teamIds: [w.snap.id],
      });
    }

    // R5 宣言（基于 已花费资金的投入占比）
    const invTechSpent = w.dec.investTech;
    const invFitSpent = CITY_IDS.reduce((s, c) => s + (w.dec.investFitByCity[c] ?? 0), 0);
    const invShowSpent = CITY_IDS.reduce((s, c) => s + (w.dec.investShowByCity[c] ?? 0), 0);
    const shares = computeInvestShares(invTechSpent, invFitSpent, invShowSpent);
    const hits = detectHits(w.dec.declaration);
    const minInv = V6.DECLARATION_MIN_INVESTMENT;
    const meetTech = shares.tech >= minInv.tech;
    const meetFit = shares.fit >= minInv.fit;
    const meetShow = shares.show >= minInv.show;
    const metDirections: Array<"tech" | "fit" | "show"> = [];
    const hitDirections: Array<"tech" | "fit" | "show"> = [];
    if (hits.tech.length > 0) hitDirections.push("tech");
    if (hits.fit.length > 0) hitDirections.push("fit");
    if (hits.show.length > 0) hitDirections.push("show");
    if (hits.tech.length > 0 && meetTech) metDirections.push("tech");
    if (hits.fit.length > 0 && meetFit) metDirections.push("fit");
    if (hits.show.length > 0 && meetShow) metDirections.push("show");

    let declReward = 0;
    if (metDirections.length >= 3) {
      declReward += V6.BQI_RULES.declarationDirectionTriple;
    } else if (metDirections.length === 2) {
      declReward += V6.BQI_RULES.declarationDirectionDouble;
    } else if (metDirections.length === 1) {
      declReward += V6.BQI_RULES.declarationDirectionBase;
    }
    if (hits.vision.length > 0) {
      declReward += V6.BQI_RULES.declarationVisionBonus;
    }
    if (declReward > V6.BQI_RULES.declarationRewardCap) declReward = V6.BQI_RULES.declarationRewardCap;
    if (declReward > 0) {
      bqiContribs.push({
        rule: "declarationReward",
        delta: declReward,
        note: `宣言说到做到：命中方向 ${metDirections.map((x) => x.toUpperCase()).join(" / ") || "无"}${hits.vision.length > 0 ? "；带有愿景口吻" : ""}。`,
      });
      pushNews({
        roundNo,
        kind: "declaration_win",
        headline: `【${w.snap.displayName}】宣言走心 市场留下印象`,
        body: say2(
          `dw-${w.snap.id}-${roundNo}`,
          `《${w.snap.productName}》把宣言里押注的方向，落实到了本回合资金盘的分配中。`,
          `《${w.snap.productName}》对外讲的故事与“钱流去哪里”更一致，观感更可信赖。`,
        ),
        teamIds: [w.snap.id],
      });
    }
    // R6 方向命中但投入严重偏差
    const deviationHits: Array<"tech" | "fit" | "show"> = [];
    const th = V6.DECLARATION_DEVIATION_THRESHOLD_PP;
    if (hits.tech.length > 0 && shares.tech < minInv.tech - th) deviationHits.push("tech");
    if (hits.fit.length > 0 && shares.fit < minInv.fit - th) deviationHits.push("fit");
    if (hits.show.length > 0 && shares.show < minInv.show - th) deviationHits.push("show");
    if (deviationHits.length > 0) {
      bqiContribs.push({
        rule: "declarationDeviationMinor",
        delta: V6.BQI_RULES.declarationDeviationMinor,
        note: `口号喊得响，钱却没投在刀口上（${deviationHits.join(" / ")}）。`,
      });
      pushNews({
        roundNo,
        kind: "declaration_miss",
        headline: `【${w.snap.displayName}】宣言与投入出现落差`,
        body: say2(
          `dm-${w.snap.id}-${roundNo}`,
          `《${w.snap.productName}》在口号中强调 ${deviationHits.join(" / ")} 等方向，但本回合资源倾斜仍显不足。`,
          `《${w.snap.productName}》的对外重点与实际投入结构略不对齐，口碑侧需要补课。`,
        ),
        teamIds: [w.snap.id],
      });
    }

    const bqiRaw = 1 + bqiContribs.reduce((s, x) => s + x.delta, 0);
    const bqi = clamp(bqiRaw, V6.BQI_RULES.floor, V6.BQI_RULES.ceil);
    const clipped = Math.abs(bqi - bqiRaw) > 1e-6;

    const noise = noiseSample();
    const eff = totalRawByTeam[w.snap.id] * bqi * (1 + noise);

    const hotpulse = hotpulseByTeam[w.snap.id];
    if (hotpulse > 0) {
      pushNews({
        roundNo,
        kind: "hot_pulse",
        headline: `【${w.snap.displayName}】${hotpulseLabelByTeam[w.snap.id]}`,
        body: say2(
          `hp-${w.snap.id}-${roundNo}`,
          `《${w.snap.productName}》展示面热度抬升明显，话题发酵带来一段额外的公众注意力。`,
          `《${w.snap.productName}》在公众侧完成一次有效出圈，本回合声量有可观加成。`,
        ),
        teamIds: [w.snap.id],
      });
    }

    const techInvestRaw = w.dec.investTech;
    const totalSpent = techInvestRaw + invFitSpent + invShowSpent;

    // 初始化结果；rank / weightedTotal 稍后再填
    const cities: Record<CityId, CitySettlementDetail> = citiesDetailByTeam[w.snap.id];
    const sumShowDelta = CITY_IDS.reduce((s, c) => s + w.deltaShow[c], 0);

    results.push({
      teamId: w.snap.id,
      displayName: w.snap.displayName,
      productName: w.snap.productName,
      route: w.route,
      tech: w.techAfter,
      deltaTech: w.deltaTech,
      techIEff: w.techIEffVal,
      techInvestRaw,
      fBonus: w.fBonus,
      mCrowd: w.mCrowd,
      cities,
      sumShowDelta,
      rawAttention: rawAttentionByTeam[w.snap.id],
      momentum: momentumByTeam[w.snap.id],
      hotpulse,
      hotpulseLabel: hotpulseLabelByTeam[w.snap.id],
      totalRaw: totalRawByTeam[w.snap.id],
      bqi,
      bqiClipped: clipped,
      bqiContribs,
      noise,
      effAttention: eff,
      rank: 0,
      weightedRoundScore: 0,
      weightedTotal: w.snap.weightedTotalBefore,
      attentionTotal: w.snap.attentionTotalBefore,
      declarationHits: hits,
      investShares: { tech: shares.tech, fit: shares.fit, show: shares.show },
      followOnNextRound: 0,
      consecutiveTop3After: w.snap.consecutiveTop3,
      spent: {
        tech: techInvestRaw,
        fit: invFitSpent,
        show: invShowSpent,
        switchCost: 0,
        expandCost: 0,
        total: totalSpent,
        reserved: 0,
      },
      routeCrowd: {
        ...crowdLevelOf(routeCount[w.route] ?? 0),
        hasBlueOceanSomewhere,
      },
    });
  }

  // —— Step 9：排名、加权累计、follow_on
  results.sort((a, b) => b.effAttention - a.effAttention);
  const weight = V6.ROUND_WEIGHTS[roundNo] ?? 0.25;
  results.forEach((r, i) => {
    r.rank = i + 1;
    r.weightedRoundScore = r.effAttention * weight;
    r.weightedTotal = r2(r.weightedTotal + r.weightedRoundScore);
    r.attentionTotal = r2(r.attentionTotal + r.effAttention);
    const top3 = r.rank <= 3;
    r.consecutiveTop3After = top3 ? r.consecutiveTop3After + 1 : 0;

    if (roundNo < V6.ROUNDS) {
      const base = Math.max(0, V6.FOLLOW_ON.maxBase - r.rank);
      let penalty = 0;
      if (r.consecutiveTop3After >= 3) penalty = V6.FOLLOW_ON.consecutive3Decay;
      else if (r.consecutiveTop3After === 2) penalty = V6.FOLLOW_ON.consecutive2Decay;
      r.followOnNextRound = Math.max(V6.FOLLOW_ON.floor, base + penalty);
    } else {
      r.followOnNextRound = 0;
    }
  });

  // —— 额外新闻：连冠、路线切换、开通城、R3 事件、独占红利
  const eventMeta = V6.EVENTS.find((e) => e.id === eventId);
  if (eventId !== "none") {
    const ed = eventMeta?.desc ?? "市场迎来突发变量。";
    pushNews({
      roundNo,
      kind: "event_r3",
      headline: `R${roundNo} 突发事件 · ${eventMeta?.label ?? eventId}`,
      body: eventR3Narrative(eventId, ed, roundNo),
      teamIds: [],
    });
  }
  if (routeCount.PATHFINDER === 1) {
    const only = works.find((w) => w.route === "PATHFINDER");
    if (only) {
      pushNews({
        roundNo,
        kind: "pathfinder_boom",
        headline: `【${only.snap.displayName}】破局独行 独占红利 +28.5%`,
        body: say2(
          `pfb-${only.snap.id}-${roundNo}`,
          `全场仅此一队押注破局奇兵，本回合在差异化上吃到更清亮的加成。`,
          `在更拥挤的常规路径之外，《${only.snap.productName}》的打法显得更稀缺，也更有红利。`,
        ),
        teamIds: [only.snap.id],
      });
    }
  } else if (routeCount.PATHFINDER >= 3) {
    const pfs = works.filter((w) => w.route === "PATHFINDER");
    pushNews({
      roundNo,
      kind: "pathfinder_crowd",
      headline: `${routeCount.PATHFINDER} 队扎堆破局 红利消散`,
      body: say2(
        `pfc-${routeCount.PATHFINDER}-r${roundNo}`,
        `多支队伍同时挤上同一条破局线，独占有色眼镜红利被迅速冲散。`,
        `当大家都往同一头押注，边际收益更像“大锅饭”，路越走越挤。`,
      ),
      teamIds: pfs.map((w) => w.snap.id),
    });
  }
  for (const w of works) {
    if (w.justExpandedCities.length > 0) {
      pushNews({
        roundNo,
        kind: "city_debut",
        headline: `【${w.snap.displayName}】开辟新战场`,
        body: say2(
          `cd-${w.snap.id}-${roundNo}-${w.justExpandedCities.join()}`,
          `《${w.snap.productName}》在 ${w.justExpandedCities.join("、")} 挂出新灯牌，市场正等待首秀的底色。`,
          `新市场开张，《${w.snap.productName}》把存在感铺到更多城市，本回合以试水与铺垫为主。`,
        ),
        teamIds: [w.snap.id],
      });
    }
    if (w.snap.route !== w.route) {
      pushNews({
        roundNo,
        kind: "route_switch",
        headline: `【${w.snap.displayName}】战略调转 转向 ${V6.ROUTES[w.route].label}`,
        body: say2(
          `rs-${w.snap.id}-${roundNo}`,
          `《${w.snap.productName}》本回合将主航道收束到 ${V6.ROUTES[w.route].label}，为下一阶段重定调。`,
          `《${w.snap.productName}》在打法上更强调 ${V6.ROUTES[w.route].label} 的叙事：${V6.ROUTES[w.route].tagline}。`,
        ),
        teamIds: [w.snap.id],
      });
    }
  }
  // 头名
  if (results.length > 0) {
    const champ = results[0];
    pushNews({
      roundNo,
      kind: "rank_top",
      headline: `R${roundNo} 冠军 · 【${champ.displayName}】拿下全场关注度`,
      body: say2(
        `rt-${champ.teamId}-${roundNo}`,
        `《${champ.productName}》以本轮最强综合表现站上榜首，把全场关注收入囊中。`,
        `《${champ.productName}》在有效关注度上拔得头筹，本回合的赢家写得很清楚。`,
      ),
      teamIds: [champ.teamId],
    });
  }
  // 天花板拉升亮点
  for (const pie of cityPies) {
    if (pie.ceiling >= 0.75) {
      const top = pie.slices.reduce((a, b) => (a.value > b.value ? a : b), { value: 0, teamId: "", displayName: "", productName: "" });
      pushNews({
        roundNo,
        kind: "ceiling_boost",
        headline: `${pie.cityId}市关注度天花板冲至 ${(pie.ceiling * 100).toFixed(0)}%`,
        body: say2(
          `cb-${pie.cityId}-${roundNo}`,
          `${pie.cityId}市多队同场竞逐，把可承载的舆论注意力也一并托高。`,
          `${pie.cityId}市投放更密集，本城能“吃下的蛋糕盘面”与上限同步抬升。`,
        ),
        teamIds: top.teamId ? [top.teamId] : [],
      });
    }
  }

  return {
    roundNo,
    eventId,
    eventLabel: eventMeta?.label ?? "无事件",
    results,
    cityPies,
    news,
  };
}

function emptyCityDetail(cityId: CityId): CitySettlementDetail {
  return {
    cityId,
    justExpanded: false,
    invFit: 0,
    invShow: 0,
    fitRank: 0,
    showRank: 0,
    kCity: 0,
    deltaFit: 0,
    deltaShow: 0,
    fitAfter: V6.A_INIT,
    showAfter: V6.A_INIT,
    haloFactor: 1,
    rawShare: 0,
    rawShareByGroup: { geek: 0, pragmatic: 0, trendy: 0 },
    ceiling: 0,
    slice: 0,
    attentionRaw: 0,
  };
}
