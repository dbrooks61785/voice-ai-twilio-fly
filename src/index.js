import "dotenv/config";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";

import { twimlConnectStream } from "./twiml.js";
import { connectOpenAIRealtime } from "./openaiRealtime.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" }
});

app.register(formbody);
app.register(websocket);

const PORT = Number(process.env.PORT || 8080);

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const OPENAI_API_KEY = mustGetEnv("OPENAI_API_KEY");
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

app.get("/", async () => ({ ok: true, service: "voice-ai-twilio-fly" }));

app.get("/healthz", async () => ({ ok: true }));

/**
 * Twilio Voice webhook: configure your Twilio number to POST here.
 * This returns TwiML instructing Twilio to open a Media Stream WebSocket.
 */
app.post("/twilio/voice", async (req, reply) => {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`;
  const wsUrl = `${base.replace("http://", "ws://").replace("https://", "wss://")}/twilio-media`;

  const xml = twimlConnectStream(wsUrl);
  reply.type("text/xml").send(xml);
});

/**
 * Twilio Media Stream WebSocket endpoint.
 * Twilio connects here and sends JSON frames:
 *  - start, media, mark, stop
 */
app.get("/twilio-media", { websocket: true }, (conn, req) => {
  const log = app.log.child({ scope: "twilio-media" });
  log.info("🟢 Twilio WS connected");

  let streamSid = null;
  let openai = null;
  let sentClearRecently = false;

  function sendToTwilio(obj) {
    try {
      conn.socket.send(JSON.stringify(obj));
    } catch (e) {
      log.warn({ err: e }, "⚠️ Failed sending to Twilio");
    }
  }

  function clearTwilioAudio() {
    // Interrupt any queued audio on Twilio side
    // Only if we are actively speaking (avoid spamming)
    if (streamSid && !sentClearRecently) {
      sendToTwilio({ event: "clear", streamSid });
      sentClearRecently = true;
      setTimeout(() => (sentClearRecently = false), 250);
    }
  }

  // Connect to OpenAI as soon as Twilio connects
  openai = connectOpenAIRealtime({
    apiKey: OPENAI_API_KEY,
    model: OPENAI_REALTIME_MODEL,
    logger: log,
    onAudioDelta: (base64Audio) => {
      if (!streamSid) return;
      // Send audio back to Twilio in the required "media" shape
      sendToTwilio({
        event: "media",
        streamSid,
        media: { payload: base64Audio }
      });
    },
    onTranscript: (delta) => {
      // Optional: transcripts for debugging
      // log.info({ delta }, "📝 transcript.delta");
    },
    onSpeaking: () => {
      // If model starts speaking, you may want to clear to reduce overlap
      clearTwilioAudio();
    },
    onError: (err) => {
      log.error({ err }, "OpenAI error");
    }
  });

  conn.socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const evt = msg.event;

    if (evt === "start") {
      streamSid = msg.start?.streamSid;
      log.info({ streamSid }, "🎧 Twilio stream started");
      return;
    }

    if (evt === "media") {
      // Twilio sends base64 μ-law audio
      const payload = msg.media?.payload;
      if (!payload || !openai?.isReady()) return;

      openai.sendAudioBase64(payload);
      return;
    }

    if (evt === "stop") {
      log.info("🛑 Twilio stream stopped");
      try { openai?.close(); } catch {}
      return;
    }
  });

  conn.socket.on("close", () => {
    log.info("🔴 Twilio WS closed");
    try { openai?.close(); } catch {}
  });

  conn.socket.on("error", (err) => {
    log.error({ err }, "❌ Twilio WS error");
    try { openai?.close(); } catch {}
  });
});

app.listen({ port: PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`🚀 Server listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
