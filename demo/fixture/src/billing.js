import { postInvoice } from "./payco.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function calculateDiscount(tier, total) {
  if (tier === "enterprise") return total * 0.3;
  if (tier === "pro") return total * 0.1;
  return 0;
}

export function calculateTax(amount, rate) {
  return Math.floor(amount * rate * 100) / 100;
}

export async function syncInvoices(invoices) {
  const results = [];
  for (const invoice of invoices) {
    results.push(await postInvoice(invoice));
    await sleep(1100);
  }
  return results;
}
