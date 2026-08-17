const webpush = require("web-push");
const { getRemindersStore } = require("./lib/blobs");

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

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:example@example.com";

  if (!publicKey || !privateKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Netlify 환경변수에 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY가 설정되지 않았어요." })
    };
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  const store = getRemindersStore();
  const subscriptions = (await store.get("subscriptions", { type: "json" })) || [];
  if (subscriptions.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "저장된 구독 정보가 없어요. 먼저 알림을 켜주세요." }) };
  }

  const payload = JSON.stringify({
    title: "🔔 테스트 알림",
    body: "이 알림이 보이면 정상적으로 설정된 거예요!",
    url: "./index.html"
  });

  const results = await Promise.allSettled(subscriptions.map((sub) => webpush.sendNotification(sub, payload)));
  const sent = results.filter((r) => r.status === "fulfilled").length;

  if (sent === 0) {
    return { statusCode: 500, body: JSON.stringify({ error: "전송에 실패했어요." }) };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, sent, total: subscriptions.length }) };
};
