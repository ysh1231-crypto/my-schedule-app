const webpush = require("web-push");
const { getStore } = require("@netlify/blobs");

// Runs automatically every 5 minutes (see netlify.toml). Checks which
// reminders are due and sends a real push notification via APNs/FCM,
// which arrives even if the phone/app is completely closed. Notifies
// every paired device (subscriptions is a list, one per device).
exports.handler = async () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:example@example.com";

  if (!publicKey || !privateKey) {
    console.error("VAPID keys are not configured as environment variables");
    return { statusCode: 200, body: "vapid not configured" };
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  const store = getStore("reminders");
  const subscriptions = (await store.get("subscriptions", { type: "json" })) || [];
  const items = (await store.get("items", { type: "json" })) || [];

  if (subscriptions.length === 0 || items.length === 0) {
    return { statusCode: 200, body: "nothing to do" };
  }

  const now = Date.now();
  const due = items.filter(
    (it) => !it.deleted && it.remindEnabled && !it.remindSent && it.remindAt && new Date(it.remindAt).getTime() <= now
  );

  if (due.length === 0) {
    return { statusCode: 200, body: "no due reminders" };
  }

  let survivingSubs = subscriptions.slice();

  for (const item of due) {
    const isRead = item.type === "read";
    const payload = JSON.stringify({
      title: isRead ? `🔖 ${item.title}` : `📅 ${item.title}`,
      body: item.memo || (isRead ? "저장해둔 글을 읽어볼 시간이에요" : "일정 시간이에요"),
      url: isRead && item.url ? item.url : "./index.html"
    });

    let sentToAny = false;

    for (const sub of survivingSubs.slice()) {
      try {
        await webpush.sendNotification(sub, payload);
        sentToAny = true;
      } catch (err) {
        console.error("push send failed for item", item.id, err.statusCode || err.message);
        if (err.statusCode === 404 || err.statusCode === 410) {
          survivingSubs = survivingSubs.filter((s) => s.endpoint !== sub.endpoint);
        }
      }
    }

    if (sentToAny) {
      item.remindSent = true;
      item.updatedAt = Date.now();
    }
    // If nothing succeeded, leave remindSent false so it retries next run.
  }

  // Keep the stored list small: drop items sent more than 7 days ago.
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const pruned = items.filter((it) => !it.remindSent || new Date(it.remindAt).getTime() > weekAgo);

  await store.setJSON("items", pruned);
  if (survivingSubs.length !== subscriptions.length) {
    await store.setJSON("subscriptions", survivingSubs);
  }

  return { statusCode: 200, body: JSON.stringify({ sent: due.length }) };
};
