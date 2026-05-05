const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");
const fetch = require("node-fetch");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const SYSTEM_PROMPT = `Te egy magyar nyelvű AI asszisztens vagy egy fodrászat számára. A fodrászat neve: Kovács Barbershop. Nyitvatartás: Hétfőtől szombatig 9:00-18:00. Szolgáltatások: Hajvágás 3000 Ft, Szakállvágás 2000 Ft, Hajvágás+szakáll 4500 Ft. Mindig magyarul beszélj. Légy barátságos. Maximum 2-3 mondat.`;

const groq = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const deepgramClient = createClient(DEEPGRAM_API_KEY);

app.post("/incoming", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${req.headers.host}/stream` });
  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => res.send("Voice agent fut!"));

wss.on("connection", (ws) => {
  console.log("Uj hivas");
  let streamSid = null;
  let conversationHistory = [{ role: "system", content: SYSTEM_PROMPT }];
  let isProcessing = false;

  const dgLive = deepgramClient.listen.live({
    language: "hu",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    model: "nova-2",
  });

  dgLive.on("open", () => console.log("Deepgram OK"));

  dgLive.on("Results", async (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript || transcript.trim() === "" || isProcessing) return;
    if (data.is_final && transcript.trim().length > 2) {
      console.log("Felhasznalo:", transcript);
      isProcessing = true;
      await processUserInput(transcript);
      isProcessing = false;
    }
  });

  dgLive.on("error", (err) => console.error("Deepgram hiba:", err));

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === "start") {
        streamSid = data.start.streamSid;
        await sendTTSResponse("Jo napot! Kovacs Barbershop, miben segithetem?");
      }
      if (data.event === "media") {
        const chunk = Buffer.from(data.media.payload, "base64");
        if (dgLive.getReadyState() === 1) dgLive.send(chunk);
      }
      if (data.event === "stop") dgLive.requestClose();
    } catch (err) {
      console.error("WS hiba:", err);
    }
  });

  ws.on("close", () => { try { dgLive.requestClose(); } catch (e) {} });

  async function processUserInput(userText) {
    try {
      conversationHistory.push({ role: "user", content: userText });
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: conversationHistory,
        max_tokens: 150,
      });
      const response = completion.choices[0].message.content;
      conversationHistory.push({ role: "assistant", content: response });
      console.log("Bot:", response);
      await sendTTSResponse(response);
    } catch (error) {
      console.error("Groq hiba:", error);
    }
  }

  async function sendTTSResponse(text) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`,
        {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          }),
        }
      );
      if (!res.ok) { console.error("ElevenLabs hiba:", res.statusText); return; }
      const audio = await res.arrayBuffer();
      const base64 = Buffer.from(audio).toString("base64");
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
        ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "done" } }));
      }
    } catch (error) {
      console.error("TTS hiba:", error);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Szerver fut: ${PORT}`));
