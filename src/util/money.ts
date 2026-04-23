/** 资金统一保留 1 位小数（与「万元」等单位一致，避免浮点误差） */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/** 美式千分位，保留 1 位小数 */
export function formatMoneyUS(n: number): string {
  const x = roundMoney(n);
  const neg = x < 0;
  const s = Math.abs(x).toFixed(1);
  const [intPart, dec] = s.split(".");
  const withComma = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + withComma + "." + dec;
}

export const MONEY_EPS = 0.05;
