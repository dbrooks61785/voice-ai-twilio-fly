import WebSocket from "ws";
import { tools, runToolCall } from "./tools.js";

export function connectOpenAIRealtime({
  apiKey,
  model,
  logger,
  onAudioDelta,
  onTranscript,
  onError,
  onSpeaking
}) {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  let sessionReady = false;

  ws.on("open", () => {
    logger.info("✅ Connected to OpenAI Realtime");

    // Establish session config: voice + formats + VAD + tools
    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        tools,
        tool_choice: "auto",
        instructions: [
          "You are a calm, professional operations intake coordinator for EZ Lumper Services.",
          "Ask one question at a time.",
          "Collect: service type, job city, job state, company name, contact name, email, phone number.",
          "Confirm details back to the caller clearly.",
          "Never mention CRMs, automation, tools, or internal systems.",
          "If the caller is upset or stressed, acknowledge and stay calm.",
          "When you have all required fields, call create_intake_record."
        ].join(" ")
      }
    };

    ws.send(JSON.stringify(sessionUpdate));
    sessionReady = true;
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      logger.warn({ err: e }, "⚠️ Failed to parse OpenAI message");
      return;
    }

    // Helpful debugging in production (keep log level sane)
    if (msg.type && msg.type.endsWith(".error")) {
      logger.error({ msg }, "❌ OpenAI error event");
      onError?.(msg);
      return;
    }

    // Audio out (to Twilio)
    if (msg.type === "response.audio.delta" && msg.delta) {
      onSpeaking?.(); // tell caller stream to clear / interrupt as needed
      onAudioDelta(msg.delta);
      return;
    }

    // Transcripts (optional)
    if (msg.type === "response.audio_transcript.delta" && msg.delta) {
      onTranscript?.(msg.delta);
      return;
    }

    // Tool calling
    if (msg.type === "response.function_call_arguments.done") {
      // This event usually pairs with prior function_call info
      // We’ll handle function calls from response.output below if present.
      return;
    }

    // Function call items can appear in response.output
    if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
      const { name, arguments: argsJson, call_id } = msg.item;
      let args = {};
      try {
        args = argsJson ? JSON.parse(argsJson) : {};
      } catch {
        args = {};
      }

      logger.info({ name }, "🧰 Tool requested");

      const result = await runToolCall(name, args);

      // Send tool result back
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id,
          output: JSON.stringify(result)
        }
      }));

      // Tell model it can continue
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  });

  ws.on("close", () => {
    logger.info("🔌 OpenAI Realtime connection closed");
  });

  ws.on("error", (err) => {
    logger.error({ err }, "❌ OpenAI Realtime ws error");
    onError?.(err);
  });

  return {
    isReady: () => sessionReady && ws.readyState === WebSocket.OPEN,
    sendAudioBase64: (base64) => {
      // Stream inbound audio into OpenAI buffer
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64
      }));
    },
    close: () => ws.close()
  };
}
