const { getStore } = require("@netlify/blobs");

// Full cross-device sync for every item (schedule, to-do, to-read).
// Protected by a shared passphrase (SYNC_CODE) the user sets once in Netlify
// and enters on each device — this is a personal single-user app, not a
// multi-account system, so a shared secret is enough.
//
// Merge strategy: last-write-wins per item, compared by `updatedAt`.
// Deletes are soft (item.deleted = true) so a delete on one device can
// correctly "win" over a stale copy still held on another device.

function checkAuth(event) {
  const expected = process.env.SYNC_CODE;
  if (!expected) return { ok: false, statusCode: 501, message: "SYNC_CODE가 서버에 설정되어 있지 않아요." };
  const provided = event.headers["x-sync-code"] || event.headers["X-Sync-Code"];
  if (!provided || provided !== expected) {
    return { ok: false, statusCode: 401, message: "동기화 코드가 올바르지 않아요." };
  }
  return { ok: true };
}

exports.handler = async (event) => {
  const auth = checkAuth(event);
  if (!auth.ok) return { statusCode: auth.statusCode, body: JSON.stringify({ error: auth.message }) };

  const store = getStore("reminders");

  const noStore = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  try {
    if (event.httpMethod === "GET") {
      const items = (await store.get("items", { type: "json" })) || [];
      return { statusCode: 200, headers: noStore, body: JSON.stringify({ items }) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const incoming = body.item;
      if (!incoming || !incoming.id || typeof incoming.updatedAt !== "number") {
        return { statusCode: 400, body: JSON.stringify({ error: "item(id, updatedAt 포함)이 필요해요" }) };
      }

      const items = (await store.get("items", { type: "json" })) || [];
      const idx = items.findIndex((it) => it.id === incoming.id);

      // Last-write-wins: only accept the incoming version if it's at least
      // as new as what the server already has.
      if (idx === -1) {
        items.push(incoming);
      } else if (incoming.updatedAt >= (items[idx].updatedAt || 0)) {
        items[idx] = incoming;
      }

      await store.setJSON("items", items);
      return { statusCode: 200, headers: noStore, body: JSON.stringify({ items }) };
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (err) {
    console.error("sync-items error", err);
    return { statusCode: 500, body: JSON.stringify({ error: "internal error" }) };
  }
};
