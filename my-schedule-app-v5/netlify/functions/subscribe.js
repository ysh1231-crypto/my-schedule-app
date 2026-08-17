const { getStore } = require("@netlify/blobs");

// Saves a browser's Web Push subscription so the scheduled function can
// notify it later, even while the app/phone screen is off. Subscriptions
// are kept as a list (deduped by endpoint) so multiple devices — e.g. an
// iPhone and a MacBook — can each receive reminders independently.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const expected = process.env.SYNC_CODE;
  if (!expected) {
    return { statusCode: 501, body: JSON.stringify({ error: "SYNC_CODE가 서버에 설정되어 있지 않아요." }) };
  }
  const provided = event.headers["x-sync-code"] || event.headers["X-Sync-Code"];
  if (!provided || provided !== expected) {
    return { statusCode: 401, body: JSON.stringify({ error: "동기화 코드가 올바르지 않아요." }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    if (!body.subscription || !body.subscription.endpoint) {
      return { statusCode: 400, body: JSON.stringify({ error: "subscription missing" }) };
    }

    const store = getStore("reminders");
    const subs = (await store.get("subscriptions", { type: "json" })) || [];
    const next = subs.filter((s) => s.endpoint !== body.subscription.endpoint);
    next.push(body.subscription);
    await store.setJSON("subscriptions", next);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    console.error("subscribe error", err);
    return { statusCode: 500, body: JSON.stringify({ error: "internal error" }) };
  }
};
