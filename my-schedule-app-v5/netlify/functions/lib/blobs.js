const { getStore } = require("@netlify/blobs");

function getRemindersStore() {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: "reminders", siteID, token });
  }
  return getStore("reminders");
}

module.exports = { getRemindersStore };
