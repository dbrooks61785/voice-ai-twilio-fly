import fs from "node:fs/promises";
import path from "node:path";
import { loadKbIndex, searchKb } from "./kb.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const KB_INDEX_PATH = process.env.KB_INDEX_PATH || "./data/kb_index.json";
const UNKNOWN_QUESTION_LOG_PATH = process.env.UNKNOWN_QUESTION_LOG_PATH || "./data/unknown_questions.log";
const WEBHOOK_CALLBACK_REQUEST = process.env.WEBHOOK_CALLBACK_REQUEST || "";
const WEBHOOK_TRANSFER_REQUEST = process.env.WEBHOOK_TRANSFER_REQUEST || "";
const WEBHOOK_UNKNOWN_QUESTION = process.env.WEBHOOK_UNKNOWN_QUESTION || "";

const kbIndexPromise = loadKbIndex(KB_INDEX_PATH);

export const tools = [
  {
    type: "function",
    name: "create_intake_record",
    description: "Create an intake record in the system of record (CRM/DB).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        service_type: { type: "string" },
        job_city: { type: "string" },
        job_state: { type: "string" },
        company_name: { type: "string" },
        contact_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" }
      },
      required: ["service_type", "job_city", "job_state", "company_name", "contact_name", "email", "phone"]
    }
  },
  {
    type: "function",
    name: "kb_search",
    description: "Search the company knowledge base for answers.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number" }
      },
      required: ["query"]
    }
  },
  {
    type: "function",
    name: "request_callback",
    description: "Log a callback request for dispatch or an agent.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string" },
        company_name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        reason: { type: "string" },
        issue_summary: { type: "string" },
        preferred_language: { type: "string" }
      },
      required: ["reason"]
    }
  },
  {
    type: "function",
    name: "transfer_to_agent",
    description: "Transfer to a live agent with a clear introduction.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string" },
        company_name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        issue_summary: { type: "string" },
        preferred_language: { type: "string" }
      },
      required: ["issue_summary"]
    }
  },
  {
    type: "function",
    name: "log_unknown_question",
    description: "Log a question the KB could not answer.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        topic: { type: "string" },
        caller_name: { type: "string" },
        phone: { type: "string" },
        preferred_language: { type: "string" }
      },
      required: ["question"]
    }
  }
];

// This executes tools when OpenAI requests them.
// Replace with real API calls (GHL, your DB, etc).
export async function runToolCall(name, args) {
  if (name === "create_intake_record") {
    // TODO: persist to GHL/DB
    // Keep it deterministic + idempotent in production.
    return {
      ok: true,
      message: "Intake captured.",
      captured: args
    };
  }

  if (name === "kb_search") {
    const kbIndex = await kbIndexPromise;
    return searchKb(kbIndex, args.query || "", {
      apiKey: OPENAI_API_KEY,
      model: kbIndex?.embeddingModel || OPENAI_EMBEDDING_MODEL,
      topK: Number.isFinite(Number(args.top_k)) ? Number(args.top_k) : 5
    });
  }

  if (name === "request_callback") {
    const payload = { ...args, timestamp: new Date().toISOString() };
    await postWebhook(WEBHOOK_CALLBACK_REQUEST, payload);
    return { ok: true };
  }

  if (name === "transfer_to_agent") {
    const payload = { ...args, timestamp: new Date().toISOString() };
    await postWebhook(WEBHOOK_TRANSFER_REQUEST, payload);
    return { ok: true };
  }

  if (name === "log_unknown_question") {
    const payload = { ...args, timestamp: new Date().toISOString() };
    await appendJsonLine(UNKNOWN_QUESTION_LOG_PATH, payload);
    await postWebhook(WEBHOOK_UNKNOWN_QUESTION, payload);
    return { ok: true };
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}

async function appendJsonLine(filePath, entry) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf-8");
}

async function postWebhook(url, payload) {
  if (!url) {
    return { ok: false, skipped: true };
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return { ok: resp.ok, status: resp.status };
  } catch (err) {
    return { ok: false, error: err?.message || "error" };
  }
}
