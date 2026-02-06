import express from "express";
import multer from "multer";
import fs from "fs";
import fetch from "node-fetch";
import cors from "cors";
import FormData from "form-data";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

// Servir archivos estáticos
app.use(express.static("public"));

// ------------------ SUPABASE ------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ------------------ CARGAR SCRIPT PEDAGÓGICO ------------------
const script = JSON.parse(fs.readFileSync("./script_b1_b2.json", "utf8"));

// ------------------ SESIONES EN MEMORIA ------------------
const sessions = {};
const SESSION_LIMIT = 300; // 5 minutos
// ------------------ BUSINESS MODES ------------------ 
const businessModes = {};
function getToday() {
  return new Date().toISOString().split("T")[0];
}

// ------------------ MULTER ------------------
const upload = multer({ dest: "uploads/" });

/* ============================================================
   👤 RUTA USERINFO — DATOS DEL USUARIO DESDE BACKEND
============================================================ */
app.post("/userinfo", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({ error: "Missing token" });
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const userId = authData.user.id;

    const { data: profile, error: dbError } = await supabase
      .from("users2")
      .select("*")
      .eq("id", userId)
      .single();

    if (dbError) {
      console.error("❌ Error consultando users2:", dbError);
      return res.status(400).json({ error: "User not found in users2" });
    }

    return res.json({
      id: profile.id,
      email: profile.email,
      firstname: profile.firstname,
      lastname: profile.lastname,
      plan_id: profile.plan_id,
      daily_limit_seconds: profile.daily_limit_seconds,
      academy_id: profile.academy_id
    });

  } catch (err) {
    console.error("❌ Error en /userinfo:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ============================================================
   🔊 RUTA STT — Whisper (OpenAI)
============================================================ */
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.json({ text: "" });

    const filePath = req.file.path;

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath), {
      filename: "audio.webm",
      contentType: "audio/webm"
    });
    formData.append("model", "whisper-1");
    formData.append("language", "en");
    formData.append("task", "transcribe");
    formData.append("temperature", "0");
    formData.append("prompt", "Transcribe exactly what the user says. Do not correct grammar. Do not fix mistakes. Do not rewrite sentences. Keep errors exactly as spoken.");

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData
    });

    const data = await openaiRes.json();
    fs.unlinkSync(filePath);

    res.json({ text: data.text || "" });
  } catch (err) {
    console.error("❌ Error STT:", err);
    res.json({ text: "" });
  }
});

/* ============================================================
   🔥 MOTOR PEDAGÓGICO
============================================================ */

function pickRandomTopic(previousTopic = null) {
  const topics = Object.keys(script.topics || {});
  if (topics.length === 0) return null;

  const avoidRepeat = script.flow?.rotation?.avoid_repeating_last_topic;
  let candidates = topics;

  if (avoidRepeat && previousTopic && topics.length > 1) {
    candidates = topics.filter(t => t !== previousTopic);
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickRandomSubtopic(topicKey, previousSubtopic = null) {
  const topic = script.topics[topicKey];
  if (!topic?.rotation?.subtopics) return null;

  const subList = topic.rotation.subtopics;
  const avoidRepeat =
    topic.rotation.avoid_repeating_last_subtopic ||
    script.flow?.rotation?.avoid_repeating_last_subtopic;

  let candidates = subList;

  if (avoidRepeat && previousSubtopic && subList.length > 1) {
    candidates = subList.filter(s => s !== previousSubtopic);
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function initSession(ip) {
  const prev = sessions[ip] || {};
  const previousTopic = prev.topic || prev.lastTopic || null;
  const topic = pickRandomTopic(previousTopic);

  const previousSubtopic = prev.subtopic || prev.lastSubtopic || null;
  const subtopic = pickRandomSubtopic(topic, previousSubtopic);

  sessions[ip] = {
    phase: "warmup",
    topic,
    subtopic,
    questionIndex: 0,
    guidedCount: 0,
    expansionCount: 0,
    name: prev.name || null,
    userId: prev.userId || null,
    lastTopic: topic,
    lastSubtopic: subtopic
  };

  console.log(`🆕 Nueva sesión para IP ${ip} → Tema: ${topic}, Subtema: ${subtopic}`);
}

function getPromptForPhase(ip, userMessage) {
  const session = sessions[ip];
  const phase = session.phase;
  const topicKey = session.topic;
  const subtopicKey = session.subtopic;

  if (!script || !script.phases) {
    return "Continue the conversation in a simple, friendly way.";
  }

  if (phase === "warmup") {
    return script.prompts?.warmup || "Ask a simple warm-up question.";
  }

  if (phase === "topic_intro") {
    const topic = script.topics[topicKey];
    const intro = topic?.intro || "";
    const base = script.prompts?.topic_intro || "Introduce the topic naturally.";
    return `${base} Topic: "${intro}"`;
  }

  if (phase === "guided_questions") {
    const topic = script.topics[topicKey];
    const sub = topic?.subtopics?.[subtopicKey];
    const questions = sub?.questions || [];
    const idx = session.questionIndex || 0;
    const qObj = questions[idx] || questions[0];
    const qText = qObj?.q || "Ask an open-ended question.";

    const base = script.prompts?.guided_question || "Ask an open-ended question.";
    return `${base} Use this idea: "${qText}"`;
  }

  if (phase === "correction") {
    const base = script.prompts?.correction || "Correct the student's message briefly.";
    return `${base} Student said: "${userMessage}"`;
  }

  if (phase === "expansion") {
    const topic = script.topics[topicKey];
    const expList = topic?.expansion || [];
    const example = expList[0] || "Ask a deeper follow-up question.";
    const base = script.prompts?.expansion || "Ask a deeper follow-up question.";
    return `${base} For example: "${example}"`;
  }

  if (phase === "wrapup") {
    const base = script.prompts?.wrapup || "Give positive feedback and summarize.";
    return base;
  }

  return "Continue the conversation naturally.";
}

function advancePhase(ip) {
  const session = sessions[ip];
  const phase = session.phase;
  const topicKey = session.topic;
  const subtopicKey = session.subtopic;

  if (phase === "warmup") {
    session.phase = "topic_intro";
  } else if (phase === "topic_intro") {
    session.phase = "guided_questions";
    session.guidedCount = 0;
    session.questionIndex = 0;
  } else if (phase === "guided_questions") {
    const topic = script.topics[topicKey];
    const sub = topic?.subtopics?.[subtopicKey];
    const total = sub?.questions?.length || 0;

    session.guidedCount++;
    session.questionIndex++;

    const minQ = script.phases.guided_questions?.min_questions || 3;
    const maxQ = script.phases.guided_questions?.max_questions || 6;

    const enough = session.guidedCount >= minQ;
    const end = session.questionIndex >= total;
    const maxed = session.guidedCount >= maxQ;

    if (maxed || (enough && end)) {
      session.phase = "expansion";
      session.expansionCount = 0;
    }
  } else if (phase === "expansion") {
    session.expansionCount++;
    const maxExp = script.phases.expansion?.rules?.max_questions || 2;
    if (session.expansionCount >= maxExp) {
      session.phase = "wrapup";
    }
  } else if (phase === "wrapup") {
    initSession(ip);
  }

  console.log(`➡️ IP ${ip} avanza a fase: ${sessions[ip].phase}`);
}

function getBusinessPrompt(mode) {
  switch (mode) {
    case "negotiation":
      return `
You are now in Business English: Negotiation mode.
Use professional vocabulary, negotiation strategies, and realistic scenarios.
Simulate a negotiation partner. Ask questions, propose terms, and challenge the student.
Keep answers concise but realistic.
`;

    case "job_interview":
      return `
You are now in Business English: Job Interview mode.
Act as an HR recruiter. Ask interview-style questions.
Evaluate answers and give short feedback.
Use formal tone and professional vocabulary.
`;

    case "sales":
      return `
You are now in Business English: Sales Call mode.
Act as a potential client or prospect.
Use objections, ask for clarifications, and simulate a real sales conversation.
Keep answers short and dynamic.
`;

    default:
      return "";
  }
}

app.post("/setBusinessMode", (req, res) => {
  const { userId, mode } = req.body;
  console.log("📥 /setBusinessMode recibido:", { userId, mode });
  if (!userId) {
    console.log("❌ No llegó userId");
    return res.status(400).json({ error: "Missing userId" });
  }

  if (mode === "exit") {
    businessModes[userId] = null;
  } else {
    businessModes[userId] = mode;
  }
  console.log("💾 businessModes ahora:", businessModes);
  return res.json({ ok: true, activeMode: businessModes[userId] });
});

/* ============================================================
   🤖 RUTA CHAT — GPT‑4o‑mini + TTS
============================================================ */

app.post("/chat", async (req, res) => {
  console.log("📥 BODY CHAT:", req.body);
  
  let { message, history, firstname, lastname, userId, email } = req.body;


  await supabase.from("users").upsert({ userId, firstname, lastname, email });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;

  if (!sessions[ip]) initSession(ip);

  if (!sessions[ip].userId && userId) sessions[ip].userId = userId;

  const effectiveUserId = userId || null;
  console.log("🔎 businessModes en /chat:", businessModes);
  console.log("🔎 userId recibido en /chat:", userId);
  console.log("🔎 activeMode:", businessModes[userId]);

  const today = getToday();
  let used = 0;

  if (effectiveUserId) {
    const { data } = await supabase
      .from("usage2")
      .select("seconds")
      .eq("user_id", effectiveUserId)
      .eq("date", today)
      .maybeSingle();

    used = data?.seconds || 0;
  }

  /* ============================================================
     ⛔ LÍMITE DE TIEMPO — AHORA CON TTS
  ============================================================ */
  if (used >= SESSION_LIMIT) {
    const limitMessage = "I'm sorry, but you reached your 5‑minute limit for today, but don't be sad, we can meet again tomorrow.";

    // Generar TTS también para este mensaje
    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "shimmer",
        input: limitMessage,
        format: "wav"
      })
    });

    const arrayBuffer = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString("base64");

    return res.json({
      reply: limitMessage,
      audio: audioBase64,
      timeSpentToday: used
    });
  }

/* ============================================================
   🧠 CHAT NORMAL / BUSINESS
============================================================ */

let phasePrompt = "";
const activeMode = businessModes[userId];

// 👉 DECLARAR historyMessages SIEMPRE
let historyMessages = [];

// 👉 Detectar si es auto‑inicio de entrevista
let isAutoStart = false;
if (activeMode && message === "__start_interview__") {
  isAutoStart = true;
  // el usuario no ha dicho nada aún, damos una orden genérica al modelo
  message = "Start the interview.";
}

if (!activeMode) {
  phasePrompt = getPromptForPhase(ip, message);
}

let systemPrompt = "";


// 👉 Ahora ya puedes usar historyMessages sin errores
// Do NOT correct grammar unless the mistake makes the sentence hard to understand.

if (!activeMode) {
  historyMessages = []; // reinicia la conversación
  systemPrompt = `
You are an English tutor.
Gently correct important mystakes
Ignore small errors.
Focus on conversation, not correction.
Keep answers short (max 3 sentences).
Always end with a question.
Current phase instructions: ${phasePrompt}
`;
} else {
  // 🟦 MODO BUSINESS
  systemPrompt = `
You are now in Business English: ${activeMode.replace("_", " ")} mode.
Follow the instructions strictly.
`;

  // Añadir instrucciones específicas del modo (job_interview, negotiation, etc.)
  systemPrompt += getBusinessPrompt(activeMode);

  // 🟨 Si es el primer turno de entrevista, forzamos presentación + primera pregunta
  if (isAutoStart) {
  if (activeMode === "job_interview") {
    systemPrompt += `
Start the interview from the beginning.
Introduce yourself as the HR recruiter.
Thank the candidate for attending.
Explain the position briefly.
Then ask the first standard interview question: "Can you tell me about yourself?"
`;
  }

  if (activeMode === "client_meeting") {
    systemPrompt += `
Start the meeting professionally.
Introduce yourself as the client's account manager.
Thank them for joining the meeting.
Explain the purpose of the meeting briefly.
Then ask the first question: "Before we begin, could you tell me a bit about your company’s current needs?"
`;
  }

  if (activeMode === "presentation") {
    systemPrompt += `
Start the presentation scenario.
Introduce yourself as the presenter.
Explain the topic of the presentation briefly.
Set the context and the audience.
Then begin with: "Let’s start with a quick overview. What do you already know about this topic?"
`;
  }

  if (activeMode === "negotiation") {
    systemPrompt += `
Start the negotiation scenario.
Introduce yourself as the negotiation counterpart.
Set the context of the negotiation.
Explain the goal of the meeting briefly.
Then begin with: "Before we discuss terms, could you share your main priorities?"
`;
  }

  if (activeMode === "sales_call") {
    systemPrompt += `
Start the sales call scenario.
Introduce yourself as the potential client.
Set the context of the call.
Explain what you are looking for.
Then begin with: "Before we continue, could you tell me more about your product or service?"
`;
  }

  if (activeMode === "conflict_resolution") {
    systemPrompt += `
Start the conflict resolution scenario.
Introduce yourself as the mediator or manager.
Set the context of the conflict.
Explain the goal of the conversation.
Then begin with: "To understand the situation better, could you explain your perspective?"
`;
  }
}

}


// 👉 Rellenar historial SOLO si NO estamos en modo Business
if (!activeMode && Array.isArray(history)) {
  history.forEach(turn => {
    if (turn.user) historyMessages.push({ role: "user", content: turn.user });
    if (turn.bot) historyMessages.push({ role: "assistant", content: turn.bot });
  });
}

console.log("🧠 systemPrompt FINAL:", systemPrompt);


  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      max_tokens: 120,
      messages: [
        { role: "system", content: systemPrompt },
        ...historyMessages,
        { role: "user", content: message }
      ]
    })
  });

  const data = await openaiRes.json();
  const reply = data.choices?.[0]?.message?.content || "Error";

 if (!activeMode) {
  advancePhase(ip);
}


  const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "shimmer",
      input: reply,
      format: "wav"
    })
  });

  const arrayBuffer = await ttsRes.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString("base64");

  res.json({
    reply,
    audio: audioBase64,
    timeSpentToday: used
  });
});
/* ============================================================
   🔊 RUTA TTS — PARA EL SALUDO INICIAL
============================================================ */
app.post("/tts", async (req, res) => {
  const { text } = req.body;

  try {
    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "shimmer",
        input: text,
        format: "wav"
      })
    });

    const arrayBuffer = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString("base64");

    res.json({ audio: audioBase64 });
  } catch (err) {
    console.error("❌ Error en /tts:", err);
    res.json({ audio: null });
  }
});

/* ============================================================
   ⏱ RUTA PARA SUMAR TIEMPO
============================================================ */
console.log("🟢 Registrando ruta /ttsTime DESDE ESTA VERSION");

app.post("/ttsTime", async (req, res) => {
  console.log("📥 BODY TTS:", req.body);

  const { seconds, userId } = req.body;
  const today = getToday();

  if (!userId) {
    console.log("❌ No llegó userId, no sumo tiempo");
    return res.json({ ok: false, error: "Missing userId" });
  }

  const effectiveUserId = userId;

  // 1) Leer registro existente
  const { data: existing } = await supabase
    .from("usage2")
    .select("seconds")
    .eq("user_id", effectiveUserId)
    .eq("date", today)
    .maybeSingle();

  const previous = existing?.seconds || 0;
  const newTotal = previous + seconds;

  // 2) Guardar
const { error } = await supabase
  .from("usage2")
  .upsert(
    {
      user_id: effectiveUserId,
      date: today,
      seconds: newTotal
    },
    { onConflict: "user_id,date" }
  );

if (error) {
  console.log("❌ Error al guardar en usage2:", error);
  return res.json({ ok: false, error: error.message });
}

console.log("📝 Guardado en usage2:", {
  user_id: effectiveUserId,
  date: today,
  seconds: newTotal
});

return res.json({ ok: true, total: newTotal });
});

/* ============================================================
   🚀 INICIAR SERVIDOR
============================================================ */
console.log("🟢 BACKEND ACTUAL CARGADO — VERSION TTS FIX");
app.listen(3000, () => console.log("🚀 Servidor listo en puerto 3000"));
