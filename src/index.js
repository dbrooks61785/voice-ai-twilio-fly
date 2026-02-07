import "dotenv/config";
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { twimlConnectStream } from './twiml.js';

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
const GHL_PIT_TOKEN = process.env.GHL_PIT_TOKEN || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const WEBHOOK_NEW_ORDER = process.env.WEBHOOK_NEW_ORDER || '';
const WEBHOOK_EXISTING_UPDATE = process.env.WEBHOOK_EXISTING_UPDATE || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';

function requireEnv(value, name) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
requireEnv(OPENAI_API_KEY, 'OPENAI_API_KEY');
requireEnv(WEBHOOK_NEW_ORDER, 'WEBHOOK_NEW_ORDER');
requireEnv(WEBHOOK_EXISTING_UPDATE, 'WEBHOOK_EXISTING_UPDATE');

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

function validateTwilio(req) {
  if (!TWILIO_ACCOUNT_SID) return true;
  const accountSid = req.headers['x-twilio-accountsid'];
  if (accountSid && accountSid === TWILIO_ACCOUNT_SID) {
    return true;
  }
  req.log.warn({ accountSid }, 'Unauthorized Twilio account');
  return false;
}

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
  if (Array.isArray(result.customFields)) {
    for (const f of result.customFields) {
      const name = (f.name || '').toLowerCase();
      if (f.value && name.includes('load')) {
        loadNumber = f.value;
      }
      if (f.value && name.includes('reservation')) {
        reservationNumber = f.value;
      }
    }
  }

  return {
    found: true,
    firstName: result.firstName || 'Valued Customer',
    company: result.companyName || 'your company',
    email: result.email || '',
    load_number: loadNumber,
    reservation_number: reservationNumber
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
        LANGUAGE:
        - Detect the caller's language from their first response.
        - If not English, continue the conversation in that language.
        - If the language is unclear or mixed, ask which language they prefer.
        - When calling tools, translate all fields to English.
        KNOWLEDGE BASE:
        - You can rely on ezlumperservices.com and all pages linked from that site.
        - You can rely on the haulpass.ezlumperservices.com home page only.
        SAFETY:
        - Only discuss info from the knowledge base or this caller's account.
        - Never reveal internal processes, internal tools, policies, or business secrets.
        - Never read back or repeat sensitive data (passwords, credit cards, SSNs, tokens).
        - If sensitive data is provided, acknowledge and ask them not to share it; if confirmation is needed, use masking (e.g., last 4 digits).
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
        LANGUAGE: Detect the caller's language. If not English, continue in that language.
        If the language is unclear or mixed, ask which language they prefer.
        Always submit tool fields in English, translating caller responses as needed.
        KNOWLEDGE BASE: ezlumperservices.com and all linked pages; haulpass.ezlumperservices.com home page only.
        SAFETY: Only discuss info from the knowledge base or this caller's account.
        Never reveal internal processes, internal tools, policies, or business secrets.
        Never read back or repeat sensitive data (passwords, credit cards, SSNs, tokens).
        If sensitive data is provided, acknowledge and ask them not to share it; if confirmation is needed, use masking (e.g., last 4 digits).
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
        const args = JSON.parse(response.arguments || '{}');
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
          await fetch(WEBHOOK_NEW_ORDER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(translatedArgs)
          });
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: response.call_id,
              output: JSON.stringify({ success: true })
            }
          }));
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: 'Confirm dispatch has been notified.' }
          }));
        } else if (functionName === 'report_existing_issue') {
          const finalLoadNumber = args.load_number || contact.load_number || contact.reservation_number || 'Unknown';
          const payload = { ...args, load_number: finalLoadNumber };
          if (contact.found) {
            payload.caller_name = payload.caller_name || contact.firstName;
            payload.phone = payload.phone || callerPhone;
          }
          const translatedPayload = await translateFieldsToEnglish(payload, ['call_notes'], log);
          await fetch(WEBHOOK_EXISTING_UPDATE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(translatedPayload)
          });
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: response.call_id,
              output: JSON.stringify({ success: true })
            }
          }));
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: "Say: 'I have sent those notes to dispatch regarding that load/reservation number. They will call you shortly.'" }
          }));
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
