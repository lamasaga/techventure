import { Router, type NextFunction, type Request, type Response } from "express";
import {
  createTeam,
  deleteTeam,
  effectiveAvailable,
  getJudgeData,
  getLatestNews,
  getLeaderboard,
  getNewsForRound,
  getPlayPoll,
  getPlayState,
  getRoundByNo,
  getRoundControl,
  getScreenData,
  getTeamByCode,
  listRounds,
  listTeams,
  openNextPending,
  openRound,
  resetActivity,
  seedRoundsIfEmpty,
  setRoundEvent,
  settleOpenRound,
  submitPlay,
  updateTeam,
  type PlaySubmitPayload,
} from "../services/gameService.js";
import { V6 } from "../engine/config.js";

const ADMIN_PASSWORD = process.env.TV_ADMIN_PASSWORD || "admin";

export const apiRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.admin) {
    res.status(401).json({ error: "需要管理员登录" });
    return;
  }
  next();
}
function requireTeam(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.teamId) {
    res.status(401).json({ error: "请先使用队伍编号登录" });
    return;
  }
  next();
}
function requireJudge(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.judge) {
    res.status(401).json({ error: "需要投资人登录" });
    return;
  }
  next();
}

/* ───────────── 公开参数 / 元信息 ───────────── */
apiRouter.get("/public/meta", (_req, res) => {
  seedRoundsIfEmpty();
  res.json({
    schema: "v6.0",
    cities: Object.entries(V6.CITIES).map(([id, v]) => ({
      id,
      label: v.label,
      scale: v.scale,
      geek: v.geek,
      prag: v.prag,
      trend: v.trend,
    })),
    routes: Object.entries(V6.ROUTES).map(([id, v]) => ({
      id,
      label: v.label,
      tagline: v.tagline,
      brief: v.brief,
      rTech: v.rTech,
      rFit: v.rFit,
      rShow: v.rShow,
      techInvestBoost: (v as { techInvestBoost?: number }).techInvestBoost,
      canTriggerHotPulse: (v as { canTriggerHotPulse?: boolean }).canTriggerHotPulse ?? false,
    })),
    events: V6.EVENTS,
    economy: {
      SEED: V6.SEED,
      ROUND_GRANT: V6.ROUND_GRANT,
      INTEREST_RATE: V6.INTEREST_RATE,
      ROUTE_SWITCH_COST: V6.ROUTE_SWITCH_COST,
      CITY_EXPAND_COST: V6.CITY_EXPAND_COST,
    },
    declarationKeywords: V6.DECLARATION_KEYWORDS,
  });
});

apiRouter.get("/public/leaderboard", (_req, res) => {
  res.json(getLeaderboard());
});

apiRouter.get("/public/rounds", (_req, res) => {
  seedRoundsIfEmpty();
  res.json({ rounds: listRounds() });
});

apiRouter.get("/public/news", (req, res) => {
  const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 40));
  // 公共滚动新闻不展示博弈信息（例如更换路线）
  res.json({ news: getLatestNews(limit).filter((n) => n.kind !== "route_switch") });
});

apiRouter.get("/public/news/:roundNo", (req, res) => {
  const no = Number(req.params.roundNo);
  // 公共滚动新闻不展示博弈信息（例如更换路线）
  res.json({ news: getNewsForRound(no).filter((n) => n.kind !== "route_switch") });
});

apiRouter.get("/public/screen", (_req, res) => {
  res.json(getScreenData());
});

/* ───────────── 登录 ───────────── */
apiRouter.post("/auth/admin", (req, res) => {
  const { password } = req.body as { password?: string };
  if (password === ADMIN_PASSWORD) {
    req.session.admin = true;
    res.json({ ok: true });
    return;
  }
  res.status(403).json({ error: "口令错误" });
});

apiRouter.post("/auth/team", (req, res) => {
  const { teamCode, pin } = req.body as { teamCode?: string; pin?: string };
  if (!teamCode || typeof teamCode !== "string") {
    res.status(400).json({ error: "请填写队伍编号" });
    return;
  }
  const team = getTeamByCode(teamCode);
  if (!team) {
    res.status(404).json({ error: "队伍编号不存在" });
    return;
  }
  if (team.pin && team.pin !== (pin ?? "")) {
    res.status(403).json({ error: "队伍口令错误" });
    return;
  }
  req.session.teamId = team.id;
  res.json({
    ok: true,
    team: { team_code: team.team_code, team_name: team.team_name, product_name: team.product_name },
  });
});

apiRouter.post("/auth/judge", (req, res) => {
  const { password } = req.body as { password?: string };
  const pw = process.env.TV_JUDGE_PASSWORD || process.env.TV_ADMIN_PASSWORD || "admin";
  if (password === pw) {
    req.session.judge = true;
    res.json({ ok: true });
    return;
  }
  res.status(403).json({ error: "口令错误" });
});

apiRouter.post("/auth/logout", (req, res) => {
  const { scope } = (req.body ?? {}) as { scope?: "team" | "admin" | "judge" | "all" };
  const s = scope ?? "all";
  if (s === "team") {
    delete req.session.teamId;
    res.json({ ok: true });
    return;
  }
  if (s === "admin") {
    delete req.session.admin;
    res.json({ ok: true });
    return;
  }
  if (s === "judge") {
    delete req.session.judge;
    res.json({ ok: true });
    return;
  }
  req.session.destroy(() => res.json({ ok: true }));
});

/* ───────────── 管理端 ───────────── */
const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.get("/state", (_req, res) => {
  seedRoundsIfEmpty();
  const screen = getScreenData();
  res.json({
    teams: listTeams(),
    rounds: listRounds(),
    leaderboard: getLeaderboard(),
    roundControl: getRoundControl(),
    timer: screen.timer,
    serverTime: screen.serverTime,
  });
});

adminRouter.post("/teams", (req, res) => {
  const b = req.body as {
    team_code?: string;
    team_name?: string;
    product_name?: string;
    pin?: string;
    route?: string;
    homeCity?: string;
  };
  try {
    const t = createTeam({
      team_code: b.team_code ?? "",
      team_name: b.team_name ?? "",
      product_name: b.product_name,
      pin: b.pin,
      route: (b.route as never) || undefined,
      homeCity: (b.homeCity as never) || undefined,
    });
    res.json(t);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminRouter.patch("/teams/:id", (req, res) => {
  try {
    const t = updateTeam(req.params.id, req.body);
    if (!t) {
      res.status(404).json({ error: "队伍不存在" });
      return;
    }
    res.json(t);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminRouter.delete("/teams/:id", (req, res) => {
  const ok = deleteTeam(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "队伍不存在" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.post("/rounds/next/open", (_req, res) => {
  const r = openNextPending();
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json(r.round);
});

adminRouter.post("/rounds/current/settle", (_req, res) => {
  const r = settleOpenRound();
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true, round: r.round, leaderboard: getLeaderboard() });
});

adminRouter.post("/rounds/:roundNo/event", (req, res) => {
  const roundNo = Number(req.params.roundNo);
  const { eventId } = req.body as { eventId?: string };
  if (!eventId || !V6.EVENTS.some((e) => e.id === eventId)) {
    res.status(400).json({ error: "无效 eventId" });
    return;
  }
  const r = setRoundEvent(roundNo, eventId as never);
  if (!("ok" in r) || !r.ok) {
    res.status(400).json({ error: (r as { error: string }).error });
    return;
  }
  res.json(r.round);
});

adminRouter.post("/rounds/:roundNo/open", (req, res) => {
  const roundNo = Number(req.params.roundNo);
  const r = openRound(roundNo);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json(r.round);
});

adminRouter.post("/activity/restart", (req, res) => {
  const b = req.body as { confirm?: string; removeTeams?: boolean; defaultBudget?: number };
  if (b.confirm !== "RESTART") {
    res.status(400).json({ error: '请传入 confirm="RESTART" 以确认重置' });
    return;
  }
  const out = resetActivity({
    removeTeams: Boolean(b.removeTeams),
    defaultBudget: typeof b.defaultBudget === "number" ? b.defaultBudget : undefined,
  });
  res.json({
    ok: true,
    teamsCleared: out.teamsCleared,
    teams: listTeams(),
    rounds: listRounds(),
  });
});

apiRouter.use("/admin", adminRouter);

/* ───────────── 参赛端 ───────────── */
apiRouter.get("/play/state", requireTeam, (req, res) => {
  const st = getPlayState(req.session.teamId!);
  if (!st) {
    res.status(404).json({ error: "队伍不存在" });
    return;
  }
  res.json(st);
});

// 参赛端轻量轮询：仅用于判断是否需要刷新
apiRouter.get("/play/poll", requireTeam, (req, res) => {
  const st = getPlayPoll(req.session.teamId!);
  if (!st) {
    res.status(404).json({ error: "队伍不存在" });
    return;
  }
  res.json(st);
});

apiRouter.post("/play/submit", requireTeam, (req, res) => {
  const body = req.body as PlaySubmitPayload;
  if (!body || typeof body.roundNo !== "number") {
    res.status(400).json({ error: "roundNo 必填" });
    return;
  }
  const r = submitPlay(req.session.teamId!, body);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.json({ ok: true });
});

apiRouter.post("/play/profile", requireTeam, (req, res) => {
  const b = req.body as { team_name?: string; product_name?: string };
  try {
    const t = updateTeam(req.session.teamId!, {
      team_name: b.team_name,
      product_name: b.product_name,
    });
    if (!t) {
      res.status(404).json({ error: "队伍不存在" });
      return;
    }
    res.json({ ok: true, team: t });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/* ───────────── 投资人 ───────────── */
const judgeRouter = Router();
judgeRouter.use(requireJudge);

judgeRouter.get("/state", (_req, res) => {
  res.json({
    ...getJudgeData(),
    leaderboard: getLeaderboard(),
    rounds: listRounds(),
  });
});

apiRouter.use("/judge", judgeRouter);
