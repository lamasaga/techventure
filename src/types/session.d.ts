import "express-session";

declare module "express-session" {
  interface SessionData {
    admin?: boolean;
    judge?: boolean;
    teamId?: string;
  }
}
