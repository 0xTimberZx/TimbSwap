// TimbSwap reclaim reminders — Telegram bot webhook (Supabase Edge Function, Deno).
//
// Opt-in flow (self-declared deep link):
//   Frontend "Remind me on Telegram" → https://t.me/<bot>?start=<wallet>
//   Telegram delivers "/start <wallet>" to this webhook → we upsert the
//   wallet↔chat_id link. The worker (scripts/reclaim-reminder.js) later DMs that
//   chat before the wallet's §14 refund window lapses.
//
// Commands:
//   /start <0x…>   subscribe a wallet to reminders (upsert, re-activates)
//   /start         (no arg) → usage help
//   /stop          unsubscribe every wallet linked to this chat
//   anything else  → help
//
// Reminder-only, so the link is self-declared (a wallet address is public; the
// worst case is someone subscribing to a public address's already-public expiry
// timing — harmless noise). No funds, no PII beyond a Telegram chat id.
//
// Security: Telegram is told a secret token at setWebhook time and echoes it in
// the X-Telegram-Bot-Api-Secret-Token header on every delivery; we reject any
// request without the matching secret, so only Telegram can drive this.
//
// Secrets (Supabase → Project Settings → Edge Functions):
//   TELEGRAM_BOT_TOKEN          the bot (same token the settler/faucet send with)
//   TELEGRAM_WEBHOOK_SECRET     random string; also passed to setWebhook
//   SUPABASE_URL                (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY   (auto-injected) — bypasses RLS
//
// Deploy: supabase functions deploy telegram-webhook --no-verify-jwt
// Register: see dev-docs/RECLAIM_REMINDERS.md (setWebhook with the secret).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.4";

const BOT_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const HOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const SB_URL     = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function reply(chatId: number | string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (_e) { /* a failed reply must not 500 the webhook */ }
}

Deno.serve(async (req) => {
  // Only Telegram, carrying the shared secret, may drive this.
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== HOOK_SECRET) {
    return new Response("forbidden", { status: 401 });
  }

  let update: any;
  try { update = await req.json(); } catch { return new Response("ok"); } // ignore junk

  const msg = update?.message ?? update?.edited_message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId || !text) return new Response("ok"); // non-message update — nothing to do

  const sb = createClient(SB_URL, SB_SERVICE);
  const HELP =
    "TimbSwap refund reminders 🕒\n\n" +
    "I'll DM you before an active ticket's refund window lapses, so you never " +
    "forfeit a stake by forgetting.\n\n" +
    "Subscribe:  /start <your wallet address>\n" +
    "Stop:       /stop";

  // /start [wallet]
  if (text === "/start" || text.startsWith("/start ") || text.startsWith("/start@")) {
    const parts = text.split(/\s+/);
    const arg = parts.length > 1 ? parts[1] : "";
    if (!arg) { await reply(chatId, HELP); return new Response("ok"); }

    let wallet: string;
    try {
      wallet = ethers.getAddress(arg).toLowerCase(); // validates checksum/shape
    } catch {
      await reply(chatId, "That doesn't look like a wallet address. Try:  /start 0xYourAddress");
      return new Response("ok");
    }

    const { error } = await sb.from("reclaim_subscribers").upsert(
      { wallet, chat_id: String(chatId), active: true, updated_at: new Date().toISOString() },
      { onConflict: "wallet" },
    );
    if (error) {
      await reply(chatId, "Couldn't save that just now — please try again in a moment.");
      return new Response("ok");
    }
    await reply(
      chatId,
      `✅ Subscribed. I'll remind you before the refund window closes for\n${wallet}\n\nSend /stop anytime to turn this off.`,
    );
    return new Response("ok");
  }

  // /stop — unsubscribe every wallet linked to this chat
  if (text === "/stop" || text.startsWith("/stop@")) {
    await sb.from("reclaim_subscribers")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("chat_id", String(chatId));
    await reply(chatId, "🔕 Reminders off. Send /start <wallet> to turn them back on.");
    return new Response("ok");
  }

  await reply(chatId, HELP);
  return new Response("ok");
});
