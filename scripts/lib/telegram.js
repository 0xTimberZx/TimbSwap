// lib/telegram.js — ops alerts, best-effort.
//
// A Telegram failure must never fail a keeper: every send swallows its own
// errors and logs them. Two conventions the fleet already follows are encoded
// here so a new keeper cannot get them subtly wrong:
//
//   • Markdown is retried as plain text. Error dumps contain `_ * [ ]` which
//     break Markdown parsing, and a dropped alert is exactly the alert you
//     needed (an RPC 403 once went unnoticed this way).
//   • The ops-mode switch (TELEGRAM_OPS_MODE): "all" sends everything,
//     "errors" only lines that open with an alert glyph, "off" nothing. It
//     never affects a community stream, which is a separate chat id.

const ALERT_GLYPH = /^[❌⚠️💥♻️🚨]/u;

/**
 * makeTelegram({ token, chatId, mode, tag, preview }) → { enabled, mode, send, notify }
 *   send(text, { markdown })  always sends (mode "off" still suppresses)
 *   notify(text)              honours mode "errors": routine beats are dropped
 * `tag` prefixes log lines so several keepers' output stays attributable.
 * `preview` keeps link previews (off by default: ops alerts carry tx links
 * and error dumps; a community stream that links the site wants them on).
 */
function makeTelegram({ token, chatId, mode = "all", tag = "tg", preview = false } = {}) {
  const m = String(mode || "all").toLowerCase();
  const enabled = Boolean(token && chatId) && m !== "off";
  const url = token ? `https://api.telegram.org/bot${token}/sendMessage` : null;

  async function post(body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, disable_web_page_preview: !preview, ...body }),
    });
  }

  async function send(text, { markdown = false } = {}) {
    if (!enabled) return false;
    try {
      let res = await post(markdown ? { text, parse_mode: "Markdown" } : { text });
      if (!res.ok && markdown) {
        console.error(`[${tag}] Markdown send failed, retrying plain text:`, await res.text());
        res = await post({ text });
      }
      if (!res.ok) { console.error(`[${tag}] send error:`, await res.text()); return false; }
      return true;
    } catch (e) {
      console.error(`[${tag}] send failed (non-fatal):`, e.message);
      return false;
    }
  }

  async function notify(text, opts) {
    if (m === "errors" && !ALERT_GLYPH.test(text)) return false;
    return send(text, opts);
  }

  return { enabled, mode: m, send, notify };
}

/**
 * Re-alert throttle: true when no alert has been sent for this key, or the last
 * one is older than `intervalSec`. Witnesses use it so a keeper that stays
 * stuck produces one message per interval, not one per run.
 */
function shouldRealert(lastAlertedAtSec, nowSec, intervalSec) {
  if (!lastAlertedAtSec) return true;
  return nowSec - lastAlertedAtSec >= intervalSec;
}

module.exports = { ALERT_GLYPH, makeTelegram, shouldRealert };
