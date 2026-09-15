// AI helpers built on the Claude Agent SDK.
// The SDK drives the local `claude` binary, so it uses whatever you're logged
// into Claude Code with (subscription) unless ANTHROPIC_API_KEY is set.
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = process.env.AI_MODEL; // e.g. "sonnet" or "opus"; unset = your Claude Code default

async function askJson({ system, prompt, schema }) {
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
      },
    },
  },
  required: ['questions'],
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

  const out = await askJson({ system, prompt, schema: questionSchema });
  return out.questions.slice(0, count);
}

const hintSchema = {
  type: 'object',
  properties: { hint: { type: 'string' } },
  required: ['hint'],
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

  const out = await askJson({ system, prompt, schema: hintSchema });
  return out.hint;
}
