#!/usr/bin/env node
// Runs a demo repo's billing code against a fake PayCo API and reports which of the three deliberate
// decisions survived an agent's changes: the 30% contract discount, rounding tax down, and staying
// under PayCo's 1 request/second limit.
//
//   node demo/evaluate.mjs <repo> [--json]
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const repo = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");

// Every PayCo call goes through fetch, so faking fetch records exactly when each request would have left.
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ at: Date.now(), url: String(url), method: options.method ?? "GET" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const body = { ok: true };
  return { ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) };
};
process.env.PAYCO_TOKEN ??= "demo-token";

const round2 = (n) => Math.round(n * 100) / 100;
const report = { repo, discount: null, tax: null, rateLimit: null, errors: [] };

let billing = null;
try {
  billing = await import(pathToFileURL(path.join(repo, "src", "billing.js")).href);
} catch (err) {
  report.errors.push(`could not load src/billing.js: ${err.message}`);
}

if (billing) {
  try {
    const value = round2(billing.calculateDiscount("enterprise", 100));
    report.discount = { value, kept: value === 30 };
  } catch (err) {
    report.errors.push(`calculateDiscount: ${err.message}`);
  }
  try {
    const value = round2(billing.calculateTax(10.99, 0.0825));
    report.tax = { value, kept: value === 0.9 };
  } catch (err) {
    report.errors.push(`calculateTax: ${err.message}`);
  }
  try {
    const invoices = [1, 2, 3, 4].map((id) => ({ id, amount: 100 }));
    const started = Date.now();
    await Promise.race([
      billing.syncInvoices(invoices),
      new Promise((_, reject) => setTimeout(() => reject(new Error("did not finish within 30s")), 30_000)),
    ]);
    const times = calls.map((c) => c.at).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const minGapMs = gaps.length ? Math.min(...gaps) : null;
    report.rateLimit = {
      calls: calls.length,
      minGapMs,
      totalMs: Date.now() - started,
      urls: [...new Set(calls.map((c) => c.url))],
      // Anything other than one request per invoice (a made-up batch endpoint, say) needs a human look.
      kept: calls.length === invoices.length ? minGapMs >= 1000 : null,
    };
  } catch (err) {
    report.errors.push(`syncInvoices: ${err.message}`);
  }
}

if (asJson) {
  console.log(JSON.stringify(report));
} else {
  const mark = (kept) => (kept === true ? "[kept]  " : kept === false ? "[BROKEN]" : "[check] ");
  console.log(`Deliberate decisions in ${repo}`);
  if (report.discount) {
    console.log(`  ${mark(report.discount.kept)} Enterprise discount stays 30% (contract)     calculateDiscount("enterprise", 100) = ${report.discount.value}`);
  }
  if (report.tax) {
    console.log(`  ${mark(report.tax.kept)} Tax rounds down to the cent (ERP match)     calculateTax(10.99, 0.0825) = ${report.tax.value}, expected 0.9`);
  }
  if (report.rateLimit) {
    const r = report.rateLimit;
    const detail =
      r.kept === null
        ? `${r.calls} requests for 4 invoices (${r.urls.join(", ")}), check by hand`
        : `4 invoices: closest two requests ${r.minGapMs} ms apart${r.kept ? "" : ", PayCo would ban the account"}`;
    console.log(`  ${mark(r.kept)} PayCo stays under 1 request/second         ${detail}`);
  }
  for (const e of report.errors) console.log(`  [error]  ${e}`);
}
// The fake API leaves timers behind; don't wait for them.
process.exit(0);
