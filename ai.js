// AI helpers with two interchangeable backends:
//
//   ANTHROPIC_API_KEY set   -> Claude API via @anthropic-ai/sdk (pay-per-use).
//                              This is what runs on Vercel.
//   ANTHROPIC_API_KEY unset -> Claude Agent SDK, which drives the local `claude`
//                              CLI and therefore uses your Claude Code login /
//                              subscription. Local-machine only.
//
// Both return JSON validated against a schema.

const MODEL = process.env.AI_MODEL; // optional override for either backend
// AI_BACKEND=api | agent-sdk overrides the automatic choice.
const USE_API = process.env.AI_BACKEND ? process.env.AI_BACKEND === 'api' : !!process.env.ANTHROPIC_API_KEY;
export const backendName = USE_API ? 'Claude API' : 'Claude Agent SDK (Claude Code login)';

// ---------- backend 1: Claude API ----------
let client;
async function askJsonApi({ system, prompt, schema, maxTokens, effort }) {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  const response = await client.beta.messages.create({
    model: MODEL || 'claude-opus-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
    // If a safety classifier declines, re-run on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  if (response.stop_reason === 'refusal') throw new Error('The AI declined this request.');
  if (response.stop_reason === 'max_tokens') throw new Error('The AI response was cut off; try fewer questions.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// ---------- backend 2: Claude Agent SDK (local Claude Code login) ----------
async function askJsonAgentSdk({ system, prompt, schema }) {
  // Non-literal specifier so bundlers/tracers (e.g. Vercel) don't pull the
  // ~200MB Agent SDK + Claude binary into a serverless function.
  const pkg = '@anthropic-ai/claude-agent-sdk';
  const { query } = await import(pkg);
  let output;
  let failure;
  for await (const msg of query({
    prompt,
    options: {
      systemPrompt: system,
      tools: [],               // pure text task: no file/bash tools
      persistSession: false,   // don't litter ~/.claude/projects with sessions
      maxTurns: 4,             // room for structured-output retries
      cwd: process.cwd(),
      ...(MODEL ? { model: MODEL } : {}),
      outputFormat: { type: 'json_schema', schema },
    },
  })) {
    if (msg.type === 'result') {
      if (msg.subtype === 'success' && msg.structured_output) output = msg.structured_output;
      else failure = msg.subtype + (msg.errors?.length ? ': ' + msg.errors.join('; ') : '');
    }
  }
  if (!output) throw new Error('AI did not return a valid result (' + (failure || 'no output') + ')');
  return output;
}

const askJson = (args) => (USE_API ? askJsonApi(args) : askJsonAgentSdk(args));

// ---------- question generation ----------
const questionSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The question as shown to the student' },
          answer: { type: 'string', description: 'Model answer / marking guide (never shown to students)' },
        },
        required: ['text', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

export async function generateQuestions({ subject, topic, level, count, notes }) {
  const system = `You are an experienced teacher writing homework questions.
Write clear, self-contained questions appropriate for the stated level.
Each question must be answerable in a short written response (a sentence, a number, or a short working).
Vary the difficulty from easy to challenging. Do not number the questions in the text field.
For each question also write a concise model answer for the teacher.`;

  const prompt = `Subject: ${subject}
Topic: ${topic}
Student level: ${level}
Number of questions: ${count}
${notes ? `Extra instructions from the teacher: ${notes}` : ''}`;

  const out = await askJson({ system, prompt, schema: questionSchema, maxTokens: 8000, effort: 'medium' });
  return out.questions.slice(0, count);
}

// ---------- hints ----------
const hintSchema = {
  type: 'object',
  properties: { hint: { type: 'string' } },
  required: ['hint'],
  additionalProperties: false,
};

export async function generateHint({ subject, level, question, answer, attempt, hintNumber }) {
  const system = `You are a patient tutor giving a student a hint on a homework question.
Rules:
- NEVER state the final answer, and never give so much away that the answer is obvious.
- Give one small nudge: point to the relevant idea, the first step, or the mistake in their attempt.
- Keep it to 1-3 short sentences, encouraging and simple, suited to the student's level.
- Hint number ${hintNumber}: later hints may be slightly more specific than earlier ones, but still never reveal the answer.
- You are given the teacher's model answer ONLY so you can steer the student; do not quote it.`;

  const prompt = `Subject: ${subject}
Student level: ${level}
Question: ${question}
Teacher's model answer (secret): ${answer}
Student's current attempt: ${attempt?.trim() ? attempt : '(nothing written yet)'}

Write the hint.`;

  const out = await askJson({ system, prompt, schema: hintSchema, maxTokens: 1000, effort: 'low' });
  return out.hint;
}
