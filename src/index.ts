import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initPersistence } from "./db/state.js";
import { apiRouter } from "./routes/api.js";
import { seedRoundsIfEmpty, startAutoSettleTimer } from "./services/gameService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(cookieParser());
app.use(
  session({
    name: "tv.sid",
    secret: process.env.TV_SESSION_SECRET || "techventure-dev-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 8 * 3600 * 1000,
      sameSite: "lax",
    },
  }),
);

initPersistence();
seedRoundsIfEmpty();
startAutoSettleTimer();

app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "../public")));

const port = Number(process.env.TV_PORT || 3780);
const host = process.env.TV_HOST || "0.0.0.0";

app.listen(port, host, () => {
  console.log(`TechVenture 服务已启动: http://${host === "0.0.0.0" ? "本机IP" : host}:${port}`);
});
