import express from "express";
import crypto from "crypto";

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
app.get("/", (_req, res) => res.send("WhatsApp auto-reply webhook is running"));

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
  }
}

// 2) INCOMING MESSAGES (POST): Meta calls this for every customer message.
app.post("/webhook", async (req, res) => {
  if (!hasValidSignature(req)) return res.sendStatus(401);

  try {
    for (const entry of req.body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const phoneNumberId = value.metadata?.phone_number_id; // which business was messaged
        for (const msg of value.messages ?? []) {
          if (msg.type === "text") {
            console.log(`Message from ${msg.from}: ${msg.text.body}`);
            // Step 2 = echo bot. Later, the LLM call replaces this line.
            await sendText(phoneNumberId, msg.from, `You said: ${msg.text.body}`);
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
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
