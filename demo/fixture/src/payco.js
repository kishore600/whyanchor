// Minimal client for the PayCo invoicing API.
const BASE_URL = "https://api.payco.example/v1";

export async function postInvoice(invoice) {
  const res = await fetch(`${BASE_URL}/invoices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.PAYCO_TOKEN}`,
    },
    body: JSON.stringify(invoice),
  });
  if (!res.ok) throw new Error(`PayCo responded ${res.status}`);
  return res.json();
}
