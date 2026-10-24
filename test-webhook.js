// Pretends to be Meta so you can test the webhook locally.
// Run (with the server already running in another terminal):
//   npm run test:webhook
import crypto from "crypto";

const base = process.env.BASE_URL || "http://localhost:3000";
const { VERIFY_TOKEN, APP_SECRET } = process.env;
const phoneNumberId = process.env.PHONE_NUMBER_ID || "123456789";
const from = process.env.TEST_FROM || "919999999999";

if (!VERIFY_TOKEN || !APP_SECRET) {
  console.error("Set VERIFY_TOKEN and APP_SECRET in your .env first.");
  process.exit(1);
}

// Test 1: verification with the CORRECT token -> expect 200 and "12345"
let res = await fetch(
  `${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`
);
console.log("1) GET correct token :", res.status, await res.text(), "(expect 200, 12345)");

// Test 2: verification with a WRONG token -> expect 403
res = await fetch(
  `${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`
);
console.log("2) GET wrong token   :", res.status, "(expect 403)");

// A fake incoming WhatsApp message, shaped like Meta's real payload
const payload = JSON.stringify({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: phoneNumberId },
            messages: [
              {
                id: `wamid.TEST${Date.now()}`, // Meta always sends a unique id
                from,
                type: "text",
                text: { body: process.env.TEST_TEXT || "hello from test" },
              },
            ],
          },
        },
      ],
    },
  ],
});

// Test 3: POST with a VALID signature -> expect 200
const signature =
  "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(payload).digest("hex");
res = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
  body: payload,
});
console.log("3) POST signed       :", res.status, "(expect 200)");

// Test 4: POST with NO signature -> expect 401
res = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: payload,
});
console.log("4) POST unsigned     :", res.status, "(expect 401; the server log \"Rejected webhook call\" is normal here)");