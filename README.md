# voice-ai-twilio-fly

Production-ready Twilio Media Streams <-> OpenAI Realtime Voice bridge for Fly.io.

## What it does
- Twilio answers calls and streams audio to this app via WebSocket
- App bridges audio to OpenAI Realtime (g711_ulaw passthrough)
- App returns OpenAI speech audio back to Twilio in real time
- Tool-calling stub included (replace with CRM/DB writes)

## Requirements
- Node 20+
- Twilio Voice number
- OpenAI API key with Realtime access
- Fly.io CLI installed

## Local run
1) Install deps
```bash
npm install
cp .env.example .env
```

2) Set env in `.env`
- OPENAI_API_KEY=...
- OPENAI_REALTIME_MODEL=...

3) Start
```bash
npm run dev
```

## Twilio setup
Set your Twilio Voice number webhook:
- When a call comes in:
  - Method: POST
  - URL: https://YOUR_FLY_APP.fly.dev/twilio/voice

This route returns TwiML instructing Twilio to open a Media Stream WebSocket.

## Fly.io deploy
1) Create app
```bash
fly launch --no-deploy
```

2) Set secrets
```bash
fly secrets set OPENAI_API_KEY=sk-... OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
```

3) Deploy
```bash
fly deploy
```

4) Verify
```bash
curl https://YOUR_FLY_APP.fly.dev/healthz
```

## Push to GitHub
```bash
git init
git add .
git commit -m "Initial production voice bridge"
git branch -M main
git remote add origin https://github.com/YOURNAME/YOURREPO.git
git push -u origin main
```
