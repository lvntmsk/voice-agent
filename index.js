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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pqHfZKP75CvOlQylNhV4"; // Neo Atti

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

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
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

// ---- WEBSOCKET STREAM ----
wss.on("connection", (ws) => {
  console.log("Új hívás csatlakozott");

  let streamSid = null;
  let callSid = null;
  let conversationHistory = [
    { role: "system", content: SYSTEM_PROMPT }
  ];
  let isProcessing = false;
  let audioBuffer = Buffer.alloc(0);

  // Deepgram kapcsolat
  const deepgramConnection = deepgramClient.listen.live({
    model: "nova-2",
    language: "hu",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
  });

  deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log("Deepgram kapcsolat megnyílt");
  });

  deepgramConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript || transcript.trim() === "" || isProcessing) return;
    if (data.is_final && transcript.trim().length > 2) {
      console.log("Felhasználó mondta:", transcript);
      isProcessing = true;
      await processUserInput(transcript, ws, streamSid);
      isProcessing = false;
    }
  });

  deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error("Deepgram hiba:", err);
  });

  // Twilio üzenetek
  ws.on("message", async (message) => {
    const data = JSON.parse(message);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      callSid = data.start.callSid;
      console.log("Stream indult:", streamSid);
      // Üdvözlő üzenet
      await sendTTSResponse("Jó napot! Kovács Barbershop, miben segíthetek?", ws, streamSid);
    }

    if (data.event === "media") {
      const audioChunk = Buffer.from(data.media.payload, "base64");
      if (deepgramConnection.getReadyState() === 1) {
        deepgramConnection.send(audioChunk);
      }
    }

    if (data.event === "stop") {
      console.log("Hívás befejezve");
      deepgramConnection.finish();
    }
  });

  ws.on("close", () => {
    console.log("WebSocket lezárva");
    deepgramConnection.finish();
  });

  // GPT-4o válasz generálás
  async function processUserInput(userText, ws, streamSid) {
    try {
      conversationHistory.push({ role: "user", content: userText });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: conversationHistory,
        max_tokens: 150,
        temperature: 0.7,
      });

      const assistantResponse = completion.choices[0].message.content;
      conversationHistory.push({ role: "assistant", content: assistantResponse });

      console.log("Bot válasza:", assistantResponse);
      await sendTTSResponse(assistantResponse, ws, streamSid);
    } catch (error) {
      console.error("GPT hiba:", error);
    }
  }

  // ElevenLabs TTS
  async function sendTTSResponse(text, ws, streamSid) {
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

      // Küld Twiliónak
      if (ws.readyState === WebSocket.OPEN) {
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

// ---- SZERVER INDÍTÁS ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Szerver fut: ${PORT}`);
});
