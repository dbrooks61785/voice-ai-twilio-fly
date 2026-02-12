import "dotenv/config";
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { validateRequest } from 'twilio';
import { twimlConnectStream } from './twiml.js';
import { ingestKb, loadKbIndex, searchKb } from './kb.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' }
});
app.register(formbody);
app.register(websocket);

const PORT = Number(process.env.PORT || 8080);
const VOICE = process.env.VOICE || 'ember';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const OPENAI_TRANSLATE_MODEL = process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini';
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const KB_INDEX_PATH = process.env.KB_INDEX_PATH || './data/kb_index.json';
const KB_REFRESH_ON_START = process.env.KB_REFRESH_ON_START === 'true';
const KB_MAX_PAGES = Number.isFinite(Number(process.env.KB_MAX_PAGES)) ? Number(process.env.KB_MAX_PAGES) : 80;
const KB_MIN_CHARS = Number.isFinite(Number(process.env.KB_MIN_CHARS)) ? Number(process.env.KB_MIN_CHARS) : 300;
const KB_CHUNK_SIZE = Number.isFinite(Number(process.env.KB_CHUNK_SIZE)) ? Number(process.env.KB_CHUNK_SIZE) : 1200;
const KB_CHUNK_OVERLAP = Number.isFinite(Number(process.env.KB_CHUNK_OVERLAP)) ? Number(process.env.KB_CHUNK_OVERLAP) : 200;
const KB_EZ_BASE_URL = process.env.KB_EZ_BASE_URL || 'https://ezlumperservices.com/';
const KB_HAULPASS_HOME = process.env.KB_HAULPASS_HOME || 'https://haulpass.ezlumperservices.com/';
const UNKNOWN_QUESTION_LOG_PATH = process.env.UNKNOWN_QUESTION_LOG_PATH || './data/unknown_questions.log';
const GHL_PIT_TOKEN = process.env.GHL_PIT_TOKEN || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const WEBHOOK_NEW_ORDER = process.env.WEBHOOK_NEW_ORDER || '';
const WEBHOOK_EXISTING_UPDATE = process.env.WEBHOOK_EXISTING_UPDATE || '';
const WEBHOOK_CALLBACK_REQUEST = process.env.WEBHOOK_CALLBACK_REQUEST || '';
const WEBHOOK_TRANSFER_REQUEST = process.env.WEBHOOK_TRANSFER_REQUEST || '';
const WEBHOOK_UNKNOWN_QUESTION = process.env.WEBHOOK_UNKNOWN_QUESTION || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';

function requireEnv(value, name) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
requireEnv(OPENAI_API_KEY, 'OPENAI_API_KEY');
requireEnv(WEBHOOK_NEW_ORDER, 'WEBHOOK_NEW_ORDER');
requireEnv(WEBHOOK_EXISTING_UPDATE, 'WEBHOOK_EXISTING_UPDATE');
requireEnv(TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN');

function extractJsonObject(text) {
  if (!text) return null;
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function translatePayloadToEnglish(payload, log) {
  try {
    const prompt = [
      'Translate all string values in the JSON object to English.',
      'Preserve keys and structure; do not add or remove fields.',
      'Do not translate names, company names, emails, phone numbers, or IDs.',
      'If a value is already English, keep it unchanged.',
      'Return JSON only.'
    ].join(' ');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_TRANSLATE_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You translate JSON values precisely.' },
          { role: 'user', content: `${prompt}\nJSON:\n${JSON.stringify(payload)}` }
        ]
      })
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.warn({ status: resp.status, body }, 'Translation request failed');
      return null;
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    return extractJsonObject(content);
  } catch (err) {
    log.warn({ err }, 'Translation request error');
    return null;
  }
}

async function translateFieldsToEnglish(payload, fields, log) {
  const subset = {};
  for (const field of fields) {
    if (typeof payload[field] === 'string' && payload[field].trim() !== '') {
      subset[field] = payload[field];
    }
  }
  if (Object.keys(subset).length === 0) {
    return payload;
  }

  const translated = await translatePayloadToEnglish(subset, log);
  if (!translated || typeof translated !== 'object') {
    return payload;
  }

  return { ...payload, ...translated };
}

let kbIndex = null;

function buildRequestUrl(req) {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');
  return `${base}${req.raw.url}`;
}

function validateTwilio(req) {
  const accountSid = req.headers['x-twilio-accountsid'];
  if (TWILIO_ACCOUNT_SID && accountSid !== TWILIO_ACCOUNT_SID) {
    req.log.warn({ accountSid }, 'Unauthorized Twilio account');
    return false;
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    req.log.warn('Missing Twilio signature');
    return false;
  }

  const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const url = buildRequestUrl(req);
  const isValid = validateRequest(TWILIO_AUTH_TOKEN, signature, url, params);
  if (!isValid) {
    req.log.warn({ url }, 'Invalid Twilio signature');
    return false;
  }

  return true;
}

async function initKb(log) {
  kbIndex = await loadKbIndex(KB_INDEX_PATH, log);

  if (KB_REFRESH_ON_START || !kbIndex) {
    ingestKb({
      apiKey: OPENAI_API_KEY,
      embeddingModel: OPENAI_EMBEDDING_MODEL,
      indexPath: KB_INDEX_PATH,
      maxPages: KB_MAX_PAGES,
      minChars: KB_MIN_CHARS,
      chunkSize: KB_CHUNK_SIZE,
      chunkOverlap: KB_CHUNK_OVERLAP,
      ezBaseUrl: KB_EZ_BASE_URL,
      haulpassHome: KB_HAULPASS_HOME,
      log
    })
      .then((index) => {
        kbIndex = index;
      })
      .catch((err) => log.error({ err }, 'KB refresh failed'));
  }
}

async function postWebhook(url, payload, log, label) {
  if (!url) {
    log?.info({ label }, 'Webhook not configured');
    return { ok: false, skipped: true };
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log?.warn({ label, status: resp.status, body }, 'Webhook request failed');
      return { ok: false, status: resp.status };
    }
    return { ok: true, status: resp.status };
  } catch (err) {
    log?.warn({ label, err }, 'Webhook request error');
    return { ok: false, error: err?.message || 'error' };
  }
}

async function appendJsonLine(filePath, entry) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, 'utf-8');
}

async function logUnknownQuestion(entry, log) {
  const payload = {
    ...entry,
    timestamp: new Date().toISOString()
  };
  await appendJsonLine(UNKNOWN_QUESTION_LOG_PATH, payload);
  await postWebhook(WEBHOOK_UNKNOWN_QUESTION, payload, log, 'unknown_question');
}

await initKb(app.log);

async function lookupContact(phoneNumber) {
  if (!phoneNumber || phoneNumber === 'Unknown' || !GHL_PIT_TOKEN || !GHL_LOCATION_ID) {
    return { found: false };
  }
  const authHeader = GHL_PIT_TOKEN.startsWith('Bearer ') ? GHL_PIT_TOKEN : `Bearer ${GHL_PIT_TOKEN}`;
  const raw10 = phoneNumber.replace(/\D/g, '').slice(-10);

  async function searchGHL(searchTerm) {
    const url = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(searchTerm)}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Version: '2021-07-28',
        'Content-Type': 'application/json'
      }
    });
    if (!resp.ok) {
      return null;
    }
    const data = await resp.json();
    return data.contacts && data.contacts.length > 0 ? data.contacts[0] : null;
  }

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
  const result = await Promise.race([searchGHL(raw10), timeout]);
  if (!result) return { found: false };

  let loadNumber = 'Unknown';
  let reservationNumber = 'Unknown';
  let jobCity = 'Unknown';
  if (Array.isArray(result.customFields)) {
    for (const f of result.customFields) {
      const name = (f.name || '').toLowerCase();
      if (f.value && name.includes('load')) {
        loadNumber = f.value;
      }
      if (f.value && name.includes('reservation')) {
        reservationNumber = f.value;
      }
      if (f.value && (name.includes('job city') || name.includes('job_city') || name.includes('jobcity'))) {
        jobCity = f.value;
      }
    }
  }

  return {
    found: true,
    firstName: result.firstName || 'Valued Customer',
    company: result.companyName || 'your company',
    email: result.email || '',
    load_number: loadNumber,
    reservation_number: reservationNumber,
    job_city: jobCity
  };
}

app.get('/', async () => ({ ok: true }));
app.get('/healthz', async () => ({ ok: true }));

app.post('/twilio/voice', async (req, reply) => {
  if (!validateTwilio(req)) {
    reply.code(403).send('Forbidden');
    return;
  }
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');
  const wsUrl = `${base.replace('http://', 'ws://').replace('https://', 'wss://')}/twilio-media`;
  const caller = (req.body && req.body.From) || (req.query && req.query.From) || '';
  const xml = twimlConnectStream(wsUrl, caller ? { caller } : {});
  reply.type('text/xml').send(xml);
});

app.get('/twilio-media', { websocket: true }, (conn, req) => {
  const log = app.log.child({ scope: 'twilio-media' });
  let streamSid = null;
  let callerPhone = 'Unknown';
  let contact = { found: false };

  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  function sendToTwilio(obj) {
    try {
      conn.socket.send(JSON.stringify(obj));
    } catch (e) {
      log.warn({ err: e }, 'Failed sending to Twilio');
    }
  }

  function sendToolOutput(callId, output) {
    openaiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output)
      }
    }));
  }

  function requestFollowup(instructions) {
    if (!instructions) {
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
      return;
    }
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: { instructions }
    }));
  }

  function sendSessionConfig(info) {
    let initialGreeting;
    let systemInstructions;
    if (info.found) {
      initialGreeting = `Hi ${info.firstName}, I'm Mike. Thank you for reaching back out to EZ Lumper Services. Are you calling about an existing service request or a new request?`;
      systemInstructions = `
        You are "Mike from EZ Lumper Services." speaking with a returning client: ${info.firstName} from ${info.company}.
        CONTEXT:
        - Name: ${info.firstName}
        - Active Load: ${info.load_number}
        - Active Reservation: ${info.reservation_number}
        - Job City on file: ${info.job_city}
        KNOWLEDGE BASE:
        - Use kb_search for questions about services, coverage, hours, pricing, billing, HaulPass, and policies.
        - Scope: ezlumperservices.com and all linked pages; haulpass.ezlumperservices.com home page only.
        FAQ SUMMARY:
        - On-demand labor with same-day availability is emphasized.
        - Assume callers already know what a lumper is unless they ask.
        - Quotes are sent by email after intake; pricing uses structured tiers.
        - Travel charges are determined by distance from the nearest dispatch zone.
        - We accept credit cards and provide invoices and receipts.
        - Office hours are listed in the knowledge base; after-hours, offer a callback next business day.
        - If asked "Where is dispatch?" or "Can I get ETA/confirmation?", say dispatch will call back with an update; use request_callback.
        - If asked to modify or cancel, use transfer_to_agent.
        - If asked about insurance, safety, compliance, or certifications, use transfer_to_agent for a callback.
        - HaulPass login requires a member number. If they do not have one, they can sign the company up; plan info is on haulpass site.
          If login issues persist, they should check with their company for the member number; if the number is correct, the account may be inactive.
        - If confirmation email is missing: ask for reservation name and company name, confirm job city on file (${info.job_city}),
          then confirm the correct email spelling and report_existing_issue to update and resend the confirmation email.
        LANGUAGE:
        - Detect the caller's language from their first response.
        - If not English, continue the conversation in that language.
        - If the language is unclear or mixed, ask which language they prefer.
        - When calling tools, translate all fields to English.
        SAFETY:
        - Only discuss info from the knowledge base or this caller's account.
        - Never reveal internal processes, internal tools, policies, or business secrets.
        - Never read back or repeat sensitive data (passwords, credit cards, SSNs, tokens).
        - If sensitive data is provided, acknowledge and ask them not to share it; if confirmation is needed, use masking (e.g., last 4 digits).
        - Never mention tool names or internal systems to the caller.
        CALLBACKS:
        - If you cannot answer from the knowledge base or caller account, log_unknown_question and request_callback.
        - Always offer a callback when you cannot answer.
        - If kb_search returns no results, log_unknown_question and request_callback.
        - If kb_search reports kb_not_ready, apologize and request_callback.
        FLOW:
        1. Wait for "Existing" or "New".
        2. EXISTING: Confirm the "Load Number" OR "Reservation Number".
           - Load Number on file: ${info.load_number}
           - Reservation Number on file: ${info.reservation_number}
           - Ask for update. Use tool "report_existing_issue".
        3. NEW: Ask for details. Use tool "submit_new_intake".
      `;
    } else {
      initialGreeting = 'EZ Lumper Services. Mike speaking. How can I help you?';
      systemInstructions = `
        You are "EZ Lumper Services." Start by saying: "${initialGreeting}"
        KNOWLEDGE BASE:
        - Use kb_search for questions about services, coverage, hours, pricing, billing, HaulPass, and policies.
        - Scope: ezlumperservices.com and all linked pages; haulpass.ezlumperservices.com home page only.
        FAQ SUMMARY:
        - On-demand labor with same-day availability is emphasized.
        - Assume callers already know what a lumper is unless they ask.
        - Quotes are sent by email after intake; pricing uses structured tiers.
        - Travel charges are determined by distance from the nearest dispatch zone.
        - We accept credit cards and provide invoices and receipts.
        - Office hours are listed in the knowledge base; after-hours, offer a callback next business day.
        - If asked "Where is dispatch?" or "Can I get ETA/confirmation?", say dispatch will call back with an update; use request_callback.
        - If asked to modify or cancel, use transfer_to_agent.
        - If asked about insurance, safety, compliance, or certifications, use transfer_to_agent for a callback.
        - HaulPass login requires a member number. If they do not have one, they can sign the company up; plan info is on haulpass site.
          If login issues persist, they should check with their company for the member number; if the number is correct, the account may be inactive.
        - If confirmation email is missing: ask for reservation name and company name, confirm job city on file,
          then confirm the correct email spelling and report_existing_issue to update and resend the confirmation email.
        LANGUAGE:
        - Detect the caller's language. If not English, continue in that language.
        - If the language is unclear or mixed, ask which language they prefer.
        - Always submit tool fields in English, translating caller responses as needed.
        SAFETY:
        - Only discuss info from the knowledge base or this caller's account.
        - Never reveal internal processes, internal tools, policies, or business secrets.
        - Never read back or repeat sensitive data (passwords, credit cards, SSNs, tokens).
        - If sensitive data is provided, acknowledge and ask them not to share it; if confirmation is needed, use masking (e.g., last 4 digits).
        - Never mention tool names or internal systems to the caller.
        CALLBACKS:
        - If you cannot answer from the knowledge base or caller account, log_unknown_question and request_callback.
        - Always offer a callback when you cannot answer.
        - If kb_search returns no results, log_unknown_question and request_callback.
        - If kb_search reports kb_not_ready, apologize and request_callback.
        INTAKE (Ask one by one): First Name, Company, Email, Location (City/State), Dock Available, Phone.
        VERIFY: Read back Name, Email, Phone (Spell out A-B-C).
        SUBMIT: Use tool "submit_new_intake".
      `;
    }

    const sessionUpdate = {
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200 },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: VOICE,
        instructions: systemInstructions,
        modalities: ['text', 'audio'],
        temperature: 0.6,
        tools: [
          {
            type: 'function',
            name: 'submit_new_intake',
            description: 'Submit a NEW Job Request.',
            parameters: {
              type: 'object',
              properties: {
                first_name: { type: 'string' },
                company_name: { type: 'string' },
                email: { type: 'string' },
                job_city: { type: 'string' },
                job_state: { type: 'string' },
                how_can_we_help_you: { type: 'string' },
                phone: { type: 'string' }
              },
              required: ['first_name', 'job_city', 'phone']
            }
          },
          {
            type: 'function',
            name: 'report_existing_issue',
            description: 'Report an issue on an EXISTING order.',
            parameters: {
              type: 'object',
              properties: {
                caller_name: { type: 'string' },
                phone: { type: 'string' },
                load_number: { type: 'string', description: 'The confirmed Load Number OR Reservation Number' },
                call_notes: { type: 'string', description: 'The update or question from the caller' }
              },
              required: ['caller_name', 'load_number', 'call_notes']
            }
          },
          {
            type: 'function',
            name: 'kb_search',
            description: 'Search the company knowledge base for answers.',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                top_k: { type: 'number' }
              },
              required: ['query']
            }
          },
          {
            type: 'function',
            name: 'request_callback',
            description: 'Log a callback request for dispatch or an agent.',
            parameters: {
              type: 'object',
              properties: {
                caller_name: { type: 'string' },
                company_name: { type: 'string' },
                phone: { type: 'string' },
                email: { type: 'string' },
                reason: { type: 'string' },
                issue_summary: { type: 'string' },
                preferred_language: { type: 'string' },
                load_number: { type: 'string' },
                reservation_number: { type: 'string' }
              },
              required: ['reason']
            }
          },
          {
            type: 'function',
            name: 'transfer_to_agent',
            description: 'Transfer to a live agent with a clear introduction.',
            parameters: {
              type: 'object',
              properties: {
                caller_name: { type: 'string' },
                company_name: { type: 'string' },
                phone: { type: 'string' },
                email: { type: 'string' },
                issue_summary: { type: 'string' },
                preferred_language: { type: 'string' },
                load_number: { type: 'string' },
                reservation_number: { type: 'string' }
              },
              required: ['issue_summary']
            }
          },
          {
            type: 'function',
            name: 'log_unknown_question',
            description: 'Log a question the KB could not answer.',
            parameters: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                topic: { type: 'string' },
                caller_name: { type: 'string' },
                phone: { type: 'string' },
                preferred_language: { type: 'string' }
              },
              required: ['question']
            }
          }
        ],
        tool_choice: 'auto'
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        instructions: `Say exactly: "${initialGreeting}"`
      }
    }));
  }
  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      if (response.type === 'response.audio.delta' && response.delta) {
        sendToTwilio({ event: 'media', streamSid, media: { payload: response.delta } });
      } else if (response.type === 'input_audio_buffer.speech_started') {
        sendToTwilio({ event: 'clear', streamSid });
        openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
      } else if (response.type === 'response.function_call_arguments.done') {
        const functionName = response.name;
        let args = {};
        try {
          args = JSON.parse(response.arguments || '{}');
        } catch {
          args = {};
        }

        if (functionName === 'submit_new_intake') {
          if (contact.found) {
            args.first_name = args.first_name || contact.firstName;
            args.company_name = args.company_name || contact.company;
            args.email = args.email || contact.email;
            args.phone = args.phone || callerPhone;
          }
          const translatedArgs = await translateFieldsToEnglish(
            args,
            ['job_city', 'job_state', 'how_can_we_help_you'],
            log
          );
          const webhookResult = await postWebhook(WEBHOOK_NEW_ORDER, translatedArgs, log, 'new_order');
          sendToolOutput(response.call_id, { success: webhookResult.ok });
          requestFollowup('Confirm the intake is complete and that a quote will be emailed shortly.');
        } else if (functionName === 'report_existing_issue') {
          const finalLoadNumber = args.load_number || contact.load_number || contact.reservation_number || 'Unknown';
          const payload = { ...args, load_number: finalLoadNumber };
          if (contact.found) {
            payload.caller_name = payload.caller_name || contact.firstName;
            payload.phone = payload.phone || callerPhone;
          }
          const translatedPayload = await translateFieldsToEnglish(payload, ['call_notes'], log);
          const webhookResult = await postWebhook(WEBHOOK_EXISTING_UPDATE, translatedPayload, log, 'existing_update');
          sendToolOutput(response.call_id, { success: webhookResult.ok });
          requestFollowup('Say: "I have sent those notes to dispatch. They will call you back shortly with an update."');
        } else if (functionName === 'kb_search') {
          const topK = Number.isFinite(Number(args.top_k)) ? Number(args.top_k) : 5;
          const result = await searchKb(kbIndex, args.query || '', {
            apiKey: OPENAI_API_KEY,
            model: kbIndex?.embeddingModel || OPENAI_EMBEDDING_MODEL,
            topK,
            log
          });
          sendToolOutput(response.call_id, result);
          requestFollowup();
        } else if (functionName === 'request_callback') {
          const payload = {
            caller_name: args.caller_name || contact.firstName || 'Unknown',
            company_name: args.company_name || contact.company || '',
            phone: args.phone || callerPhone,
            email: args.email || contact.email || '',
            reason: args.reason || args.issue_summary || 'Callback requested',
            issue_summary: args.issue_summary || args.reason || '',
            preferred_language: args.preferred_language || '',
            load_number: args.load_number || contact.load_number || '',
            reservation_number: args.reservation_number || contact.reservation_number || '',
            stream_sid: streamSid,
            source: 'voice'
          };
          const translatedPayload = await translateFieldsToEnglish(payload, ['reason', 'issue_summary'], log);
          const webhookResult = await postWebhook(WEBHOOK_CALLBACK_REQUEST, translatedPayload, log, 'callback_request');
          sendToolOutput(response.call_id, { success: webhookResult.ok });
          requestFollowup('Let the caller know dispatch will call them back with an update. Confirm their best callback number and email.');
        } else if (functionName === 'transfer_to_agent') {
          const payload = {
            caller_name: args.caller_name || contact.firstName || 'Unknown',
            company_name: args.company_name || contact.company || '',
            phone: args.phone || callerPhone,
            email: args.email || contact.email || '',
            issue_summary: args.issue_summary || '',
            preferred_language: args.preferred_language || '',
            load_number: args.load_number || contact.load_number || '',
            reservation_number: args.reservation_number || contact.reservation_number || '',
            stream_sid: streamSid,
            source: 'voice'
          };
          const translatedPayload = await translateFieldsToEnglish(payload, ['issue_summary'], log);
          const introParts = [
            translatedPayload.caller_name ? `Caller: ${translatedPayload.caller_name}` : null,
            translatedPayload.company_name ? `Company: ${translatedPayload.company_name}` : null,
            translatedPayload.phone ? `Phone: ${translatedPayload.phone}` : null,
            translatedPayload.email ? `Email: ${translatedPayload.email}` : null,
            translatedPayload.load_number ? `Load/Reservation: ${translatedPayload.load_number}` : translatedPayload.reservation_number ? `Reservation: ${translatedPayload.reservation_number}` : null,
            translatedPayload.issue_summary ? `Issue: ${translatedPayload.issue_summary}` : null,
            translatedPayload.preferred_language ? `Language: ${translatedPayload.preferred_language}` : null
          ].filter(Boolean);
          translatedPayload.introduction = introParts.join(' | ');
          const webhookResult = await postWebhook(WEBHOOK_TRANSFER_REQUEST, translatedPayload, log, 'transfer_request');
          sendToolOutput(response.call_id, { success: webhookResult.ok, introduction: translatedPayload.introduction });
          requestFollowup('Tell the caller you are transferring them to an agent now and summarize what you are passing along.');
        } else if (functionName === 'log_unknown_question') {
          const payload = {
            question: args.question || '',
            topic: args.topic || '',
            caller_name: args.caller_name || contact.firstName || 'Unknown',
            phone: args.phone || callerPhone,
            preferred_language: args.preferred_language || ''
          };
          const translatedPayload = await translateFieldsToEnglish(payload, ['question', 'topic'], log);
          await logUnknownQuestion(translatedPayload, log);
          sendToolOutput(response.call_id, { success: true });
          requestFollowup();
        } else {
          sendToolOutput(response.call_id, { success: false, error: 'Unknown tool' });
          requestFollowup();
        }
      }
    } catch (err) {
      log.error({ err }, 'Error handling OpenAI message');
    }
  });

  openaiWs.on('error', (err) => {
    log.error({ err }, 'OpenAI WebSocket error');
  });

  openaiWs.on('close', () => {
    log.info('OpenAI WebSocket closed');
  });

  conn.socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      if (msg.start.customParameters && msg.start.customParameters.caller) {
        callerPhone = msg.start.customParameters.caller;
      }
      contact = await lookupContact(callerPhone);
      if (openaiWs.readyState === WebSocket.OPEN) {
        sendSessionConfig(contact);
      } else {
        openaiWs.once('open', () => sendSessionConfig(contact));
      }
    } else if (msg.event === 'media') {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
      }
    } else if (msg.event === 'stop') {
      openaiWs.close();
    }
  });

  conn.socket.on('close', () => {
    if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
      openaiWs.close();
    }
  });
});

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`Server listening on ${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
