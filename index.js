const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const OpenAI = require("openai");
const twilio = require("twilio");
const fetch = require("node-fetch");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---- KONFIGURÁCIÓ ----
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pqHfZKP75CvOlQylNhV4";

const SYSTEM_PROMPT = `Te egy magyar nyelvű AI asszisztens vagy egy fodrászat számára.
A fodrászat neve: Kovács Barbershop.
Nyitvatartás: Hétfőtől szombatig 9:00-18:00.
Szolgáltatások és árak:
- Hajvágás: 3000 Ft
- Szakállvágás: 2000 Ft
- Hajvágás + szakáll: 4500 Ft

Ha az ügyfél időpontot szeretne foglalni, kérdezd meg:
1. A nevét
2. Mikor szeretne jönni (nap és időpont)
3. Milyen szolgáltatást kér

Mindig magyarul beszélj. Légy barátságos és segítőkész.
Röviden és érthetően válaszolj - maximum 2-3 mondat.`;

// Groq kliens (OpenAI-kompatibilis)
const groq = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const deepgramClient = createClient(DEEPGRAM_API_KEY);

// ---- TWILIO WEBHOOK ----
app.post("/incoming", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${req.headers.host}/stream`,
  });
  stream.parameter({ name: "callSid", value: req.body.CallSid });
  res.type("text/xml");
  res.send(twiml.toString());
});

// Health check
app.get("/", (req, res) => {
  res.send("Voice agent fut!");
});

// ---- WEBSOCKET STREAM ----
wss.on("connection", (ws) => {
  console.log("Uj hivas csatlakozott");

  let streamSid = null;
  let conversationHistory = [
    { role: "system", content: SYSTEM_PROMPT }
  ];
  let isProcessing = false;

  // Deepgram kapcsolat
  const deepgramConnection = deepgramClient.listen.live({
    model: "nova-2",
    language: "hu",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    interim_results: false,
  });

  deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log("Deepgram kapcsolat megnyilt");
  });

  deepgramConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript || transcript.trim() === "" || isProcessing) return;
    if (data.is_final && transcript.trim().length > 2) {
      console.log("Felhasznalo mondta:", transcript);
      isProcessing = true;
      await processUserInput(transcript);
      isProcessing = false;
    }
  });

  deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error("Deepgram hiba:", err);
  });

  // Twilio uzenetek
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("Stream indult:", streamSid);
        await sendTTSResponse("Jo napot! Kovacs Barbershop, miben segithetem?");
      }

      if (data.event === "media") {
        const audioChunk = Buffer.from(data.media.payload, "base64");
        if (deepgramConnection.getReadyState() === 1) {
          deepgramConnection.send(audioChunk);
        }
      }

      if (data.event === "stop") {
        console.log("Hivas befejezve");
        deepgramConnection.finish();
      }
    } catch (err) {
      console.error("WebSocket uzenet hiba:", err);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket lezarva");
    try { deepgramConnection.finish(); } catch (e) {}
  });

  // Groq valasz generalas
  async function processUserInput(userText) {
    try {
      conversationHistory.push({ role: "user", content: userText });

      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: conversationHistory,
        max_tokens: 150,
        temperature: 0.7,
      });

      const assistantResponse = completion.choices[0].message.content;
      conversationHistory.push({ role: "assistant", content: assistantResponse });

      console.log("Bot valasza:", assistantResponse);
      await sendTTSResponse(assistantResponse);
    } catch (error) {
      console.error("Groq hiba:", error);
    }
  }

  // ElevenLabs TTS
  async function sendTTSResponse(text) {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              speed: 1.0,
            },
          }),
        }
      );

      if (!response.ok) {
        console.error("ElevenLabs hiba:", response.statusText);
        return;
      }

      const audioBuffer = await response.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString("base64");

      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: base64Audio },
        }));
        ws.send(JSON.stringify({
          event: "mark",
          streamSid: streamSid,
          mark: { name: "done" },
        }));
      }
    } catch (error) {
      console.error("TTS hiba:", error);
    }
  }
});

// ---- SZERVER INDITAS ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Szerver fut: ${PORT}`);
});
