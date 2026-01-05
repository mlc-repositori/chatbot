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

function getToday() {
  return new Date().toISOString().split("T")[0];
}

// ------------------ MULTER ------------------
const upload = multer({ dest: "uploads/" });

// ============================================================
// 🔊 RUTA STT — Whisper (OpenAI)
// ============================================================
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.json({ text: "" });

    const filePath = req.file.path;

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("model", "whisper-1");
    formData.append("language", "en");

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

// ============================================================
// 🔥 MOTOR PEDAGÓGICO PRO (igual que tu backend antiguo)
// ============================================================

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

// ============================================================
// 🤖 RUTA CHAT — GPT‑4o‑mini + TTS en la misma respuesta
// ============================================================
app.post("/chat", async (req, res) => {
  const { message, history, firstname, lastname, userId, email } = req.body;

  // Guardar usuario en Supabase
  await supabase.from("users").upsert({ userId, firstname, lastname, email });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;

  if (!sessions[ip]) initSession(ip);

  // Antifraude
  if (!sessions[ip].userId && userId) sessions[ip].userId = userId;

  const effectiveUserId = sessions[ip].userId || userId || null;

  // Leer tiempo usado
  const today = getToday();
  let used = 0;

  if (effectiveUserId) {
    const { data } = await supabase
      .from("usage")
      .select("seconds")
      .eq("userId", effectiveUserId)
      .eq("date", today)
      .maybeSingle();

    used = data?.seconds || 0;
  }

  if (used >= SESSION_LIMIT) {
    return res.json({
      reply: "I'm sorry, but you reached your 5‑minute limit for today.",
      audio: null,
      timeSpentToday: used
    });
  }

  // Prompt pedagógico
  const phasePrompt = getPromptForPhase(ip, message);

  const systemPrompt = `
You are an English tutor.
Correct only important mistakes.
Keep answers short (max 3 sentences).
Always end with a question.
Current phase instructions: ${phasePrompt}
`;

  // Historial
  let historyMessages = [];
  if (Array.isArray(history)) {
    history.forEach(turn => {
      if (turn.user) historyMessages.push({ role: "user", content: turn.user });
      if (turn.bot) historyMessages.push({ role: "assistant", content: turn.bot });
    });
  }

  // Llamada al modelo
  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
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

  advancePhase(ip);

  // ------------------ TTS ------------------
  const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: reply
    })
  });

  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
  const audioBase64 = audioBuffer.toString("base64");

  res.json({
    reply,
    audio: audioBase64,
    timeSpentToday: used
  });
});

// ============================================================
// ⏱ RUTA PARA SUMAR TIEMPO
// ============================================================
app.post("/ttsTime", async (req, res) => {
  const { seconds, userId } = req.body;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  const today = getToday();

  if (!sessions[ip]) initSession(ip);

  if (!sessions[ip].userId && userId) sessions[ip].userId = userId;

  const effectiveUserId = sessions[ip].userId || userId || null;

  let previous = 0;

  if (effectiveUserId) {
    const { data } = await supabase
      .from("usage")
      .select("seconds")
      .eq("userId", effectiveUserId)
      .eq("date", today)
      .maybeSingle();

    previous = data?.seconds || 0;

    const newTotal = previous + seconds;

    await supabase.from("usage").upsert({
      userId: effectiveUserId,
      ip,
      date: today,
      seconds: newTotal
    });

    return res.json({ ok: true, total: newTotal });
  }

  // fallback por IP
  const { data } = await supabase
    .from("usage")
    .select("seconds")
    .eq("ip", ip)
    .eq("date", today)
    .maybeSingle();

  previous = data?.seconds || 0;
  const newTotal = previous + seconds;

  await supabase.from("usage").upsert({
    ip,
    date: today,
    seconds: newTotal
  });

  res.json({ ok: true, total: newTotal });
});

// ============================================================
// 🚀 INICIAR SERVIDOR
// ============================================================
app.listen(3000, () => console.log("🚀 Servidor listo en puerto 3000"));
