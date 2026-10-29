import express from "express";
import crypto from "crypto";
import { getDb } from "../lib/db.js";
import { generateReply } from "../lib/llm.js";

const app = express();

// Keep the raw body: Meta signs the exact bytes it sends, so we need them
// unchanged to verify the signature.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const { VERIFY_TOKEN, APP_SECRET, WHATSAPP_TOKEN, GRAPH_VERSION = "v21.0" } =
  process.env;

// Health check: open your deployed URL in a browser to see this.
app.get("/", (_req, res) => {
  // On Vercel this shows which git commit is live, so you can tell old from new.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
  res.send(`WhatsApp auto-reply webhook is running (version: ${commit})`);
});

// 1) VERIFICATION (GET): Meta calls this once when you save the webhook URL.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Confirms the request really came from Meta (HMAC-SHA256 with your App Secret).
function hasValidSignature(req) {
  const header = req.get("x-hub-signature-256");
  if (!header || !APP_SECRET || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendText(phoneNumberId, to, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!response.ok) {
    console.error("Send failed:", response.status, await response.text());
    return false;
  }
  return true;
}

// Handles one customer message: find business, save, reply, save reply.
async function handleTextMessage(db, phoneNumberId, msg) {
  const businesses = db.collection("businesses");
  const conversations = db.collection("conversations");
  const messages = db.collection("messages");

  // Which business was messaged? The phone_number_id tells us.
  const business = await businesses.findOne({ phoneNumberId });
  if (!business) {
    console.warn("No business found for phone_number_id:", phoneNumberId);
    return;
  }

  // One conversation per (business, customer). Create it if it's new.
  const conversation = await conversations.findOneAndUpdate(
    { businessId: business._id, customerNumber: msg.from },
    {
      $set: { lastMessageAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );

  // Save the customer's message. Meta re-sends a message if it doesn't get a
  // quick 200, so the same id can arrive twice. We skip it only if it was
  // already answered (or another attempt is still working on it).
  let customerDocId;
  try {
    const inserted = await messages.insertOne({
      conversationId: conversation._id,
      businessId: business._id,
      role: "customer",
      text: msg.text.body,
      ...(msg.id ? { waMessageId: msg.id } : {}),
      replied: false,
      startedAt: new Date(),
      createdAt: new Date(),
    });
    customerDocId = inserted.insertedId;
  } catch (err) {
    if (err.code !== 11000) throw err;

    const existing = await messages.findOne({ waMessageId: msg.id });
    const stillRunning =
      existing?.startedAt && Date.now() - existing.startedAt.getTime() < 60_000;
    if (!existing || existing.replied || stillRunning) {
      console.log("Duplicate message, skipping:", msg.id);
      return;
    }
    console.log("Retrying a message that was never answered:", msg.id);
    customerDocId = existing._id;
    await messages.updateOne({ _id: customerDocId }, { $set: { startedAt: new Date() } });
  }

  // The last 10 messages are the conversation "memory" we give the AI.
  const recent = await messages
    .find({ conversationId: conversation._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  const history = recent.reverse();

  let replyText;
  try {
    replyText = await generateReply({ business, history });
  } catch (err) {
    console.error("LLM error:", err.message);
    replyText =
      "Sorry, I'm having trouble right now. Our team will get back to you shortly.";
  }
  console.log(`Reply (${business.name}): ${replyText}`);
  const sent = await sendText(phoneNumberId, msg.from, replyText);

  await messages.insertOne({
    conversationId: conversation._id,
    businessId: business._id,
    role: "bot",
    text: replyText,
    sent,
    createdAt: new Date(),
  });

  // Only mark the customer message as answered if WhatsApp accepted the reply.
  if (sent) {
    await messages.updateOne({ _id: customerDocId }, { $set: { replied: true } });
  }
}

// 2) INCOMING MESSAGES (POST): Meta calls this for every customer message.
app.post("/webhook", async (req, res) => {
  if (!hasValidSignature(req)) {
    console.warn("Rejected webhook call: bad or missing signature");
    return res.sendStatus(401);
  }

  let db;
  let eventId = null;
  try {
    db = await getDb();
    const events = db.collection("webhook_events");

    // STEP A: store the raw request first, exactly as Meta sent it.
    // If anything breaks later, the original request is still saved.
    const saved = await events.insertOne({
      receivedAt: new Date(),
      status: "received",
      payload: req.body,
    });
    eventId = saved.insertedId;

    // STEP B: read it and let the chatbot reply.
    let textMessages = 0;
    for (const entry of req.body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const phoneNumberId = value.metadata?.phone_number_id;
        for (const msg of value.messages ?? []) {
          if (msg.type === "text") {
            textMessages++;
            console.log(`Message from ${msg.from}: ${msg.text.body}`);
            await handleTextMessage(db, phoneNumberId, msg);
          }
        }
      }
    }

    // STEP C: mark the stored request as handled.
    await events.updateOne(
      { _id: eventId },
      { $set: { status: "processed", textMessages, processedAt: new Date() } }
    );
  } catch (err) {
    console.error("Webhook error:", err);
    if (db && eventId) {
      await db
        .collection("webhook_events")
        .updateOne({ _id: eventId }, { $set: { status: "failed", error: String(err.message) } })
        .catch(() => {});
    }
  }

  // Always answer 200 once the signature is valid, otherwise Meta retries.
  res.sendStatus(200);
});

// Local development only; on Vercel the exported app is used instead.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

export default app;