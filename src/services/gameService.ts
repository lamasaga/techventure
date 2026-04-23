/**
 * v6.0 业务服务层：负责登录、注册、回合生命周期、提交校验、结算落库。
 */

import { v4 as uuid } from "uuid";
import {
  getState,
  getRoundReport,
  getTeamSnapshot,
  initPersistence,
  persist,
  saveSettlementOutput,
  blankFitShowByCity,
  defaultState,
  type TeamRow,
  type RoundRow,
  type SubmissionRow,
} from "../db/state.js";
import { settleRound } from "../engine/index.js";
import type {
  RoundDecision,
  SettlementContext,
  TeamEngineSnapshot,
  TeamSettlementResult,
  SettlementOutput,
} from "../engine/contracts.js";
import { V6, CITY_IDS, ROUTE_IDS, round1, techOverloadTier } from "../engine/config.js";
import type { CityId, EventId, RouteId } from "../engine/config.js";

export const EPS = 0.05;
export const ROUND_TIMER_MS = 8 * 60 * 1000;

let AUTO_TIMER: ReturnType<typeof setInterval> | null = null;

export function startAutoSettleTimer(): void {
  if (AUTO_TIMER) return;
  AUTO_TIMER = setInterval(() => {
    try {
      const open = getOpenRound();
      if (!open) return;
      const started = open.opened_at ? Date.parse(open.opened_at) : NaN;
      if (!Number.isFinite(started)) return;
      if (Date.now() >= started + ROUND_TIMER_MS) {
        settleOpenRound();
      }
    } catch {
      // ignore
    }
  }, 1000);
}

function rankMapDesc(ids: string[], valueOf: (id: string) => number): Map<string, number> {
  const arr = ids.map((id) => ({ id, v: valueOf(id) }));
  arr.sort((a, b) => b.v - a.v);
  const out = new Map<string, number>();
  let rank = 0;
  let lastV: number | null = null;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i].v;
    if (lastV === null || Math.abs(v - lastV) > 1e-9) {
      rank = i + 1;
      lastV = v;
    }
    out.set(arr[i].id, rank);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────
 * 通用工具
 * ────────────────────────────────────────────────────────── */

function asRoute(x: unknown): RouteId | null {
  return typeof x === "string" && (ROUTE_IDS as readonly string[]).includes(x) ? (x as RouteId) : null;
}

function asCity(x: unknown): CityId | null {
  return typeof x === "string" && (CITY_IDS as readonly string[]).includes(x) ? (x as CityId) : null;
}

function isEventId(x: unknown): x is EventId {
  return typeof x === "string" && V6.EVENTS.some((e) => e.id === x);
}

function asCityList(arr: unknown): CityId[] {
  if (!Array.isArray(arr)) return [];
  const set = new Set<CityId>();
  for (const x of arr) {
    const c = asCity(x);
    if (c) set.add(c);
  }
  return [...set];
}

/* ──────────────────────────────────────────────────────────
 * 队伍管理
 * ────────────────────────────────────────────────────────── */

export function listTeams(): TeamRow[] {
  return [...getState().teams].sort((a, b) => a.team_code.localeCompare(b.team_code));
}

export function getTeamById(id: string): TeamRow | undefined {
  return getState().teams.find((t) => t.id === id);
}

export function getTeamByCode(code: string): TeamRow | undefined {
  const c = code.trim().toLowerCase();
  return getState().teams.find((t) => t.team_code.toLowerCase() === c);
}

export interface TeamCreateInput {
  team_code: string;
  team_name?: string;
  product_name?: string;
  pin?: string;
  route?: RouteId;
  homeCity?: CityId;
}

export function createTeam(input: TeamCreateInput): TeamRow {
  const s = getState();
  const code = (input.team_code || "").trim();
  if (!code) throw new Error("请填写队伍编号");
  if (s.teams.some((t) => t.team_code.toLowerCase() === code.toLowerCase())) {
    throw new Error("队伍编号已存在");
  }

  // 管理端建队只需编号；队名/产品名由选手在参赛端自行填写。
  // 路线与主场也由选手在 R1 决策中选择；此处提供占位默认值，R1 提交后会覆写。
  const name = (input.team_name ?? "").trim() || code;
  const route = input.route ?? "TECH";
  const home = input.homeCity ?? "杭州";
  const id = uuid();
  const row: TeamRow = {
    id,
    team_code: code,
    pin: input.pin ?? "",
    team_name: name,
    product_name: (input.product_name ?? "").trim(),
    route,
    homeCity: home,
    opened_cities: [home],
    tech: V6.A_INIT,
    fit_by_city: blankFitShowByCity(),
    show_by_city: blankFitShowByCity(),
    budget: V6.SEED,
    pending_follow_on: 0,
    attention_total: 0,
    weighted_total: 0,
    last_rank: null,
    consecutive_top3: 0,
  };
  s.teams.push(row);
  persist();
  return row;
}

export type TeamPatch = Partial<{
  team_code: string;
  team_name: string;
  product_name: string;
  pin: string;
  budget: number;
  route: RouteId;
  homeCity: CityId;
  /** 管理端手工追加资金：直接加到队伍 budget（下一轮可用）。 */
  addFollowOn: number;
}>;

export function updateTeam(id: string, patch: TeamPatch): TeamRow | undefined {
  const s = getState();
  const t = s.teams.find((x) => x.id === id);
  if (!t) return undefined;
  if (patch.team_code !== undefined) {
    const c = String(patch.team_code).trim();
    if (!c) throw new Error("编号不能为空");
    if (s.teams.some((x) => x.id !== id && x.team_code.toLowerCase() === c.toLowerCase())) {
      throw new Error("队伍编号已存在");
    }
    t.team_code = c;
  }
  if (patch.team_name !== undefined) t.team_name = String(patch.team_name).trim();
  if (patch.product_name !== undefined) t.product_name = String(patch.product_name).trim();
  if (patch.pin !== undefined) t.pin = String(patch.pin);
  if (patch.budget !== undefined && Number.isFinite(patch.budget) && patch.budget >= 0) {
    t.budget = round1(patch.budget);
  }
  if (patch.route !== undefined) {
    const r = asRoute(patch.route);
    if (r) t.route = r;
  }
  if (patch.homeCity !== undefined) {
    const h = asCity(patch.homeCity);
    if (h) {
      t.homeCity = h;
      if (!t.opened_cities.includes(h)) t.opened_cities = [h, ...t.opened_cities];
    }
  }
  if (patch.addFollowOn !== undefined && patch.addFollowOn > 0) {
    // 业务语义：现场可手工“投资人追加”，直接进入队伍资金池（用于下一轮 Step 0）。
    t.budget = round1(t.budget + patch.addFollowOn);

    // 兼容：早期版本把“追加”写进 pending_follow_on。
    // 参赛端/大屏展示都看 budget，但为了兼容旧数据/旧前端，这里也同步累加一份。
    t.pending_follow_on = round1((t.pending_follow_on ?? 0) + patch.addFollowOn);
  }
  persist();
  return t;
}

export function deleteTeam(id: string): boolean {
  const s = getState();
  const idx = s.teams.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  s.teams.splice(idx, 1);
  // 清掉该队伍的提交/快照
  s.submissions = s.submissions.filter((x) => x.team_id !== id);
  s.snapshots = s.snapshots.filter((x) => x.team_id !== id);
  persist();
  return true;
}

/* ──────────────────────────────────────────────────────────
 * 轮次管理
 * ────────────────────────────────────────────────────────── */

export function listRounds(): RoundRow[] {
  return [...getState().rounds].sort((a, b) => a.round_no - b.round_no);
}

export function getRoundByNo(no: number): RoundRow | undefined {
  return getState().rounds.find((r) => r.round_no === no);
}

export function getOpenRound(): RoundRow | undefined {
  return getState().rounds.find((r) => r.status === "open");
}

export function getLastSettledRound(): RoundRow | undefined {
  const settled = getState().rounds.filter((r) => r.status === "settled");
  if (!settled.length) return undefined;
  return settled.reduce((a, b) => (a.round_no > b.round_no ? a : b));
}

export function getNextPendingRound(): RoundRow | undefined {
  return getState()
    .rounds.filter((r) => r.status === "pending")
    .sort((a, b) => a.round_no - b.round_no)[0];
}

export type RoundStep = "before_open" | "open_collecting" | "all_done";
export function getRoundControl(): {
  step: RoundStep;
  focus: RoundRow | null;
  canSaveEvent: boolean;
  canOpen: boolean;
  canSettle: boolean;
  hint: string;
} {
  const open = getOpenRound();
  const r3 = getRoundByNo(3);
  const canSaveEventAnytime = !!r3 && r3.status !== "settled";
  if (open) {
    return {
      step: "open_collecting",
      focus: open,
      canSaveEvent: canSaveEventAnytime,
      canOpen: false,
      canSettle: true,
      hint: `第 ${open.round_no} 轮已开放，队伍可提交；完成后点「执行本轮结算」。`,
    };
  }
  const pending = getNextPendingRound();
  if (!pending) {
    return {
      step: "all_done",
      focus: null,
      canSaveEvent: false,
      canOpen: false,
      canSettle: false,
      hint: "全部 4 轮已结算完毕。可重新开始一局。",
    };
  }
  return {
    step: "before_open",
    focus: pending,
    canSaveEvent: canSaveEventAnytime,
    canOpen: true,
    canSettle: false,
    hint: pending.round_no === 3
      ? "R3 可先确认突发事件；选完点「开放本轮提交」。"
      : `R${pending.round_no} 点「开放本轮提交」即可；R3 事件可提前预设。`,
  };
}

export function setRoundEvent(roundNo: number, eventId: EventId): { ok: true; round: RoundRow } | { ok: false; error: string } {
  if (roundNo !== 3 && eventId !== "none") {
    return { ok: false, error: "突发事件仅在 R3 可用；其它轮恒为「无事件」。" };
  }
  const r = getRoundByNo(roundNo);
  if (!r) return { ok: false, error: "轮次不存在" };
  r.event_id = eventId;
  // v6.0：事件不再改变“本轮可用资金上限”倍率；倍率字段保留用于展示与兼容。
  r.spend_cap_multiplier = 1.0;
  persist();
  return { ok: true, round: r };
}

export function openRound(roundNo: number): { ok: true; round: RoundRow } | { ok: false; error: string } {
  const s = getState();
  const r = s.rounds.find((x) => x.round_no === roundNo);
  if (!r) return { ok: false, error: "轮次不存在" };
  if (r.status === "settled") return { ok: false, error: "该轮已结算" };
  if (s.rounds.some((x) => x.status === "open" && x.round_no !== roundNo)) {
    return { ok: false, error: "已有另一轮处于开放状态，请先结算" };
  }
  if (roundNo === 3) {
    const pool = V6.EVENTS.filter((e) => e.id !== "none");
    const pick = pool[Math.floor(Math.random() * pool.length)];
    r.event_id = pick?.id ?? "none";
  } else {
    r.event_id = "none";
  }
  r.status = "open";
  r.opened_at = new Date().toISOString();
  persist();
  return { ok: true, round: r };
}

export function openNextPending(): { ok: true; round: RoundRow } | { ok: false; error: string } {
  const pending = getNextPendingRound();
  if (!pending) return { ok: false, error: "没有可开放的轮次" };
  return openRound(pending.round_no);
}

/* ──────────────────────────────────────────────────────────
 * 参赛端：Step 0 可用资金、提交
 * ────────────────────────────────────────────────────────── */

/** 计算某队在当前轮次的 Step 0 可用资金（不含路线切换/开城费的扣减；仅含基础加成）。 */
export function effectiveAvailable(team: TeamRow, round: RoundRow): number {
  return round1(team.budget * round.spend_cap_multiplier);
}

export interface PlaySubmitPayload {
  roundNo: number;
  route: RouteId;
  openedCities: CityId[];
  investTech: number;
  investFitByCity: Partial<Record<CityId, number>>;
  investShowByCity: Partial<Record<CityId, number>>;
  declaration: string;
}

export function submitPlay(teamId: string, raw: PlaySubmitPayload): { ok: true } | { ok: false; error: string } {
  const s = getState();
  const team = s.teams.find((x) => x.id === teamId);
  if (!team) return { ok: false, error: "队伍不存在" };
  const round = s.rounds.find((x) => x.round_no === raw.roundNo);
  if (!round || round.status !== "open") return { ok: false, error: "当前轮次未开放提交" };

  const route = asRoute(raw.route);
  if (!route) return { ok: false, error: "无效路线" };

  // 开城校验
  if (raw.roundNo === 1) {
    // R1：主场与路线由选手选择（仅允许选择 1 个城市，且不产生开城费）。
    const oc = asCityList(raw.openedCities);
    if (!(Array.isArray(raw.openedCities) && oc.length === 1)) {
      return { ok: false, error: "R1 必须且只能选择 1 个经营城市（将成为主场）" };
    }
  }
  const openedCities = asCityList(raw.openedCities);
  if (raw.roundNo !== 1) {
    // R2-R4：主场必须包含在经营城市中（防止误关主场）
    if (!openedCities.includes(team.homeCity)) openedCities.unshift(team.homeCity);
  }

  const newCities = openedCities.filter((c) => !team.opened_cities.includes(c));

  const switchCost = raw.roundNo > 1 && route !== team.route ? V6.ROUTE_SWITCH_COST : 0;
  const expandCost = raw.roundNo === 1 ? 0 : newCities.length * V6.CITY_EXPAND_COST;

  const available = effectiveAvailable(team, round);
  const invTech = Math.max(0, round1(Number(raw.investTech) || 0));
  const invFit: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
  const invShow: Record<CityId, number> = { 南京: 0, 合肥: 0, 杭州: 0 };
  for (const c of CITY_IDS) {
    if (!openedCities.includes(c)) continue;
    invFit[c] = Math.max(0, round1(Number(raw.investFitByCity?.[c]) || 0));
    invShow[c] = Math.max(0, round1(Number(raw.investShowByCity?.[c]) || 0));
  }

  const totalSpend =
    invTech +
    CITY_IDS.reduce((s, c) => s + invFit[c] + invShow[c], 0) +
    switchCost +
    expandCost;

  if (totalSpend > available + EPS) {
    return {
      ok: false,
      error: `本轮投入合计（含切换/开城费）${round1(totalSpend)} 超过可用上限 ${available}`,
    };
  }

  const declaration = (raw.declaration || "").toString().trim().slice(0, 60);

  const existingIdx = s.submissions.findIndex((x) => x.round_id === round.id && x.team_id === teamId);
  const row: SubmissionRow = {
    id: existingIdx >= 0 ? s.submissions[existingIdx].id : s.nextSubmissionId++,
    round_id: round.id,
    team_id: teamId,
    route,
    opened_cities: openedCities,
    invest_tech: invTech,
    invest_fit_by_city: invFit,
    invest_show_by_city: invShow,
    declaration,
    switch_cost_paid: switchCost,
    expand_cost_paid: expandCost,
    created_at: new Date().toISOString(),
  };
  if (existingIdx >= 0) s.submissions[existingIdx] = row;
  else s.submissions.push(row);

  // R1：把选手选择的经营城市固化为主场，并把已开通城市重置为该主场（避免占位默认值造成困扰）。
  if (raw.roundNo === 1) {
    const chosen = openedCities[0];
    team.homeCity = chosen;
    team.opened_cities = [chosen];
  }
  persist();
  return { ok: true };
}

export function getSubmission(teamId: string, roundId: number): SubmissionRow | null {
  const s = getState();
  return s.submissions.find((x) => x.round_id === roundId && x.team_id === teamId) ?? null;
}

/* ──────────────────────────────────────────────────────────
 * 结算：调用 v6 引擎、落库、更新队伍状态
 * ────────────────────────────────────────────────────────── */

function snapshotFor(team: TeamRow): TeamEngineSnapshot {
  return {
    id: team.id,
    displayName: team.team_name,
    productName: team.product_name,
    route: team.route,
    openedCities: [...team.opened_cities],
    tech: team.tech,
    fitByCity: { ...team.fit_by_city },
    showByCity: { ...team.show_by_city },
    lastRank: team.last_rank,
    consecutiveTop3: team.consecutive_top3,
    availableBudget: team.budget,
    weightedTotalBefore: team.weighted_total,
    attentionTotalBefore: team.attention_total,
  };
}

function defaultDecisionFor(team: TeamRow): RoundDecision {
  return {
    teamId: team.id,
    route: team.route,
    openedCities: [...team.opened_cities],
    investTech: 0,
    investFitByCity: {},
    investShowByCity: {},
    declaration: "",
  };
}

function decisionFromSubmission(sub: SubmissionRow): RoundDecision {
  return {
    teamId: sub.team_id,
    route: sub.route,
    openedCities: [...sub.opened_cities],
    investTech: sub.invest_tech,
    investFitByCity: { ...sub.invest_fit_by_city },
    investShowByCity: { ...sub.invest_show_by_city },
    declaration: sub.declaration,
  };
}

export function settleOpenRound(): { ok: true; round: RoundRow } | { ok: false; error: string } {
  const s = getState();
  const round = getOpenRound();
  if (!round) return { ok: false, error: "当前没有处于开放状态的轮次" };
  if (s.teams.length === 0) return { ok: false, error: "尚无队伍" };

  const teams = s.teams;
  const snaps = teams.map(snapshotFor);
  const decisions = teams.map((t) => {
    const sub = getSubmission(t.id, round.id);
    return sub ? decisionFromSubmission(sub) : defaultDecisionFor(t);
  });

  const ctx: SettlementContext = {
    roundNo: round.round_no as 1 | 2 | 3 | 4,
    eventId: round.event_id,
    teams: snaps,
    decisions,
    totalTeams: teams.length,
  };

  const output: SettlementOutput = settleRound(ctx);

  // 写入队伍最新状态
  for (const r of output.results) {
    const t = teams.find((x) => x.id === r.teamId);
    if (!t) continue;
    const sub = getSubmission(t.id, round.id);

    // 更新属性
    t.tech = r.tech;
    for (const c of CITY_IDS) {
      t.fit_by_city[c] = r.cities[c].fitAfter;
      t.show_by_city[c] = r.cities[c].showAfter;
    }
    // 更新路线与开通城
    if (sub) {
      t.route = sub.route;
      if (round.round_no === 1) {
        // R1：以提交为准，确定主场与已开通城
        const chosen = sub.opened_cities[0] ?? t.homeCity;
        t.homeCity = chosen;
        t.opened_cities = [chosen];
      } else {
        const merged = new Set<CityId>([...t.opened_cities, ...sub.opened_cities]);
        t.opened_cities = [...merged];
      }
    }
    // 扣钱
    const paid =
      (sub?.invest_tech ?? 0) +
      CITY_IDS.reduce((s, c) => s + (sub?.invest_fit_by_city[c] ?? 0) + (sub?.invest_show_by_city[c] ?? 0), 0) +
      (sub?.switch_cost_paid ?? 0) +
      (sub?.expand_cost_paid ?? 0);
    // cap：本轮 Step 0 可用上限（注意 cap 可能受到 spend_cap_multiplier 影响）
    const cap = effectiveAvailable(t, round);
    const reserved = round1(cap - paid);
    const remain = round1(t.budget - paid); // 实际账面余额（不受 cap 限制；cap 只是“本轮上限”）
    // 储备利息：期末剩余资金 × 15%；R1-R3 轮末都计算，R4 不再加
    const interest = round.round_no < V6.ROUNDS ? round1(Math.max(0, reserved) * V6.INTEREST_RATE) : 0;
    // 固定追加（下一轮开始）
    const eventGrant =
      round.round_no === 3 && round.event_id === "investorBoom"
        ? 30
        : 0;
    const grant = round.round_no < V6.ROUNDS ? V6.ROUND_GRANT + eventGrant : 0;
    // follow_on（下一轮到账）
    const followOn = round.round_no < V6.ROUNDS ? round1(r.followOnNextRound) : 0;
    // 更新 budget 为下一轮 Step 0 后的余额
    t.budget = round1(Math.max(0, reserved) + interest + grant + followOn);
    t.pending_follow_on = followOn;
    t.attention_total = r.attentionTotal;
    t.weighted_total = r.weightedTotal;
    t.last_rank = r.rank;
    t.consecutive_top3 = r.consecutiveTop3After;

    // 回填 spent（用于快照显示）
    r.spent.switchCost = sub?.switch_cost_paid ?? 0;
    r.spent.expandCost = sub?.expand_cost_paid ?? 0;
    r.spent.total = round1((r.spent.tech ?? 0) + (r.spent.fit ?? 0) + (r.spent.show ?? 0) + r.spent.switchCost + r.spent.expandCost);
    r.spent.reserved = round1(cap - r.spent.total);
    r.cashflow = {
      roundNo: round.round_no,
      cap: round1(cap),
      paid: round1(r.spent.total),
      reserved: round1(cap - r.spent.total),
      interest,
      grant,
      followOn,
      nextBudget: round1(t.budget),
    };
  }

  saveSettlementOutput(round.id, output);
  round.status = "settled";
  round.opened_at = null;
  persist();
  return { ok: true, round };
}

function snapshotReserve(
  sub: SubmissionRow,
  _finalBudget: number,
  _interest: number,
  _grant: number,
  _followOn: number,
  _paid: number,
): number {
  // 为展示用途：reserve = 本轮可用资金 - 本轮所有支出（投入 + 切换 + 开城）
  // 此处仅是占位，效率不重要；真正的可用资金与支出由参赛端在提交时展示。
  return 0;
}

/* ──────────────────────────────────────────────────────────
 * 读取：参赛端 / 投资人 / 大屏 / 新闻
 * ────────────────────────────────────────────────────────── */

export function getPlayState(teamId: string): {
  team: TeamRow;
  openRound: RoundRow | null;
  lastSettled: RoundRow | null;
  submission: SubmissionRow | null;
  lastSnapshot: TeamSettlementResult | null;
  lastRanks: {
    tech: { rank: number; total: number } | null;
    byCity: Partial<Record<CityId, { fit: { rank: number; total: number } | null; show: { rank: number; total: number } | null }>>;
  } | null;
  effectiveAvailable: number;
  routeLabel: string;
  overloadHint: { kappa: number; label: string };
  news: NewsRowForTeam[];
  /** 参赛端预填：最近一次提交过的口号（跨回合保留；可修改） */
  prefillDeclaration: string;
} | null {
  const team = getTeamById(teamId);
  if (!team) return null;
  const open = getOpenRound() ?? null;
  const lastSettled = getLastSettledRound() ?? null;
  const sub = open ? getSubmission(teamId, open.id) : null;
  const snap = lastSettled ? getTeamSnapshot(lastSettled.id, teamId) : null;
  const allRanks = lastSettled ? (() => {
    const s = getState();
    const snaps = s.snapshots.filter((x) => x.round_id === lastSettled.id);
    const parsed = new Map<string, TeamSettlementResult>();
    for (const row of snaps) {
      try {
        const obj = JSON.parse(row.payload) as TeamSettlementResult;
        if (obj && typeof obj.teamId === "string") parsed.set(obj.teamId, obj);
      } catch {}
    }
    const ids = [...parsed.keys()];
    if (ids.length === 0) return null;
    const techRank = rankMapDesc(ids, (id) => parsed.get(id)!.tech);

    const byCity: Partial<Record<CityId, { fit: { rank: number; total: number } | null; show: { rank: number; total: number } | null }>> = {};
    for (const c of CITY_IDS) {
      const opened = ids.filter((id) => (parsed.get(id)!.cities?.[c]?.kCity ?? 0) > 0);
      if (opened.length === 0) continue;
      const fitRank = rankMapDesc(opened, (id) => parsed.get(id)!.cities[c].fitAfter);
      const showRank = rankMapDesc(opened, (id) => parsed.get(id)!.cities[c].showAfter);
      byCity[c] = {
        fit: { rank: fitRank.get(teamId) ?? 0, total: opened.length },
        show: { rank: showRank.get(teamId) ?? 0, total: opened.length },
      };
    }
    return {
      tech: { rank: techRank.get(teamId) ?? 0, total: ids.length },
      byCity,
    };
  })() : null;
  const available = open ? effectiveAvailable(team, open) : team.budget;
  // 参赛端“新闻一栏”：只展示本队新闻，并保留每回合历史（最新回合在顶部）
  const MAX_NEWS = 240;
  const latestNews = getState()
    .news
    .filter((n) => n.team_ids.includes(team.id))
    .sort((a, b) => {
      if (a.round_no !== b.round_no) return b.round_no - a.round_no;
      return b.id - a.id;
    })
    .slice(0, MAX_NEWS)
    .map((n) => ({ ...n, related: true }));
  const prefillDeclaration =
    [...getState().submissions]
      .filter((x) => x.team_id === teamId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((x) => (x.declaration || "").trim())
      .find((x) => x.length > 0) ?? "";
  return {
    team,
    openRound: open,
    lastSettled,
    submission: sub,
    lastSnapshot: snap,
    lastRanks: allRanks,
    effectiveAvailable: available,
    routeLabel: V6.ROUTES[team.route].label,
    overloadHint: { kappa: 1, label: techOverloadTier(0).label },
    news: latestNews,
    prefillDeclaration,
  };
}

/** 参赛端轻量轮询：只返回一个用于变更检测的 key（有变化才拉 /play/state）。 */
export function getPlayPoll(teamId: string): { key: string; serverTime: string } | null {
  const team = getTeamById(teamId);
  if (!team) return null;
  const s = getState();
  const open = getOpenRound();
  const lastSettled = getLastSettledRound();
  const sub = open ? getSubmission(teamId, open.id) : null;
  const snap = lastSettled ? getTeamSnapshot(lastSettled.id, teamId) : null;

  // 注意：此 key 不需要包含全部细节，只要能在“回合开放/结算、提交变化、快照变化、资金变化”等时触发变化即可。
  const key = [
    open ? `o${open.id}:${open.round_no}:${open.status}:${open.event_id}:${open.spend_cap_multiplier}` : "o-",
    lastSettled ? `l${lastSettled.id}:${lastSettled.round_no}:${lastSettled.status}:${lastSettled.event_id}` : "l-",
    sub ? `s${sub.id}:${sub.created_at}:${sub.route}:${sub.opened_cities.join(",")}` : "s-",
    snap ? `k${(snap as { id?: number }).id ?? ""}:${(snap as { rank?: number }).rank ?? ""}` : "k-",
    `t${team.id}:${team.budget}:${team.last_rank ?? ""}:${team.weighted_total ?? ""}`,
    `n${s.nextNewsId}`,
  ].join("|");
  return { key, serverTime: new Date().toISOString() };
}

export interface NewsRowForTeam {
  id: number;
  round_no: number;
  kind: string;
  headline: string;
  body: string;
  team_ids: string[];
  created_at: string;
  related?: boolean;
}

export function getLatestNews(limit = 40): NewsRowForTeam[] {
  const s = getState();
  return [...s.news].sort((a, b) => b.id - a.id).slice(0, limit);
}

export function getNewsForRound(roundNo: number): NewsRowForTeam[] {
  const s = getState();
  return s.news.filter((n) => n.round_no === roundNo).sort((a, b) => a.id - b.id);
}

export function getLeaderboard(): {
  openRound: RoundRow | null;
  lastSettled: RoundRow | null;
  teams: Array<{
    team_code: string;
    team_name: string;
    product_name: string;
    route: RouteId;
    route_label: string;
    tech: number;
    fit_total: number;
    show_total: number;
    opened_cities: CityId[];
    weighted_total: number;
    attention_total: number;
    last_rank: number | null;
  }>;
} {
  const s = getState();
  const teams = [...s.teams]
    .map((t) => ({
      team_code: t.team_code,
      team_name: t.team_name,
      product_name: t.product_name,
      route: t.route,
      route_label: V6.ROUTES[t.route].label,
      tech: t.tech,
      fit_total: CITY_IDS.reduce((s, c) => s + t.fit_by_city[c], 0),
      show_total: CITY_IDS.reduce((s, c) => s + t.show_by_city[c], 0),
      opened_cities: [...t.opened_cities],
      weighted_total: t.weighted_total,
      attention_total: t.attention_total,
      last_rank: t.last_rank,
    }))
    .sort((a, b) => {
      const d = b.weighted_total - a.weighted_total;
      if (Math.abs(d) > 1e-6) return d;
      return b.attention_total - a.attention_total;
    });
  return {
    openRound: getOpenRound() ?? null,
    lastSettled: getLastSettledRound() ?? null,
    teams,
  };
}

export function getScreenData(): {
  openRound: RoundRow | null;
  lastSettled: RoundRow | null;
  leaderboard: ReturnType<typeof getLeaderboard>["teams"];
  perRoundReports: Array<{ round_no: number; cityPies: SettlementOutput["cityPies"]; eventLabel: string }>;
  timer: { endsAt: string; remainingMs: number; durationMs: number } | null;
  serverTime: string;
} {
  const s = getState();
  const settled = s.rounds.filter((x) => x.status === "settled").sort((a, b) => a.round_no - b.round_no);
  const perRound: Array<{ round_no: number; cityPies: SettlementOutput["cityPies"]; eventLabel: string }> = [];
  for (const r of settled) {
    const rep = getRoundReport(r.id);
    if (rep) perRound.push({ round_no: r.round_no, cityPies: rep.cityPies, eventLabel: rep.eventLabel });
  }
  const nowIso = new Date().toISOString();
  const open = getOpenRound() ?? null;
  let timer: { endsAt: string; remainingMs: number; durationMs: number } | null = null;
  if (open?.opened_at) {
    const st = Date.parse(open.opened_at);
    if (Number.isFinite(st)) {
      const end = st + ROUND_TIMER_MS;
      timer = { endsAt: new Date(end).toISOString(), remainingMs: Math.max(0, end - Date.now()), durationMs: ROUND_TIMER_MS };
    }
  }
  return {
    openRound: open,
    lastSettled: getLastSettledRound() ?? null,
    leaderboard: getLeaderboard().teams,
    perRoundReports: perRound,
    timer,
    serverTime: nowIso,
  };
}

export function getJudgeData(): {
  teams: Array<{
    id: string;
    team_code: string;
    team_name: string;
    product_name: string;
    route: RouteId;
    route_label: string;
    home_city: CityId;
    budget: number;
    weighted_total: number;
    last_rank: number | null;
    rounds: Array<{
      round_no: number;
      settled: boolean;
      submission: SubmissionRow | null;
      snapshot: TeamSettlementResult | null;
    }>;
  }>;
} {
  const s = getState();
  const teams = [...s.teams].sort((a, b) => a.team_code.localeCompare(b.team_code));
  const rounds = s.rounds.sort((a, b) => a.round_no - b.round_no);
  const packed = teams.map((t) => ({
    id: t.id,
    team_code: t.team_code,
    team_name: t.team_name,
    product_name: t.product_name,
    route: t.route,
    route_label: V6.ROUTES[t.route].label,
    home_city: t.homeCity,
    budget: t.budget,
    weighted_total: t.weighted_total,
    last_rank: t.last_rank,
    rounds: rounds.map((r) => ({
      round_no: r.round_no,
      settled: r.status === "settled",
      submission: getSubmission(t.id, r.id),
      snapshot: r.status === "settled" ? getTeamSnapshot(r.id, t.id) : null,
    })),
  }));
  return { teams: packed };
}

/* ──────────────────────────────────────────────────────────
 * 重置 / 初始化
 * ────────────────────────────────────────────────────────── */

export function seedRoundsIfEmpty(): void {
  initPersistence();
  const s = getState();
  if (s.rounds.length >= V6.ROUNDS) return;
  const fresh = defaultState();
  s.rounds = fresh.rounds;
  persist();
}

export function resetActivity(opts: { removeTeams: boolean; defaultBudget?: number }): {
  teamsCleared: boolean;
} {
  initPersistence();
  const s = getState();
  const budget = Number.isFinite(opts.defaultBudget) && (opts.defaultBudget ?? -1) >= 0 ? opts.defaultBudget! : V6.SEED;

  if (opts.removeTeams) {
    s.teams = [];
  } else {
    for (const t of s.teams) {
      t.tech = V6.A_INIT;
      t.fit_by_city = blankFitShowByCity();
      t.show_by_city = blankFitShowByCity();
      t.budget = round1(budget);
      t.pending_follow_on = 0;
      t.attention_total = 0;
      t.weighted_total = 0;
      t.last_rank = null;
      t.consecutive_top3 = 0;
      // 重开后：保留历史主场会让 R1 失去“自选主场”的意义，因此回到占位默认值。
      t.homeCity = "杭州";
      t.opened_cities = ["杭州"];
    }
  }
  s.submissions = [];
  s.snapshots = [];
  s.roundReports = [];
  s.news = [];
  s.rounds = defaultState().rounds;
  s.nextSubmissionId = 1;
  s.nextSnapshotId = 1;
  s.nextNewsId = 1;
  persist();
  return { teamsCleared: opts.removeTeams };
}
