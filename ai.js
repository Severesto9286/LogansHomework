// Question + hint generation via the Claude Agent SDK.
//
// This runs ONLY on your own machine (see generate.js). The SDK drives the local
// `claude` CLI, so it uses your Claude Code login / subscription - no API key.
// The hosted server never calls this: hints are generated here up front and
// stored with the questions.

const MODEL = process.env.AI_MODEL; // e.g. "sonnet" or "opus"; unset = your Claude Code default

async function askJson({ system, prompt, schema }) {
  // Non-literal specifier so bundlers/tracers (e.g. Vercel) never pull the
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

export const HINTS_PER_QUESTION = 3;

const homeworkSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The question as shown to the student' },
          answer: { type: 'string', description: 'Full worked model answer / marking guide (never shown to students)' },
          finalAnswer: { type: 'string', description: 'Just the final answer, written exactly in the format the question asks for' },
          hints: {
            type: 'array',
            description: `Exactly ${HINTS_PER_QUESTION} progressive hints, from a gentle nudge to nearly-there, never revealing the answer`,
            items: { type: 'string' },
          },
        },
        required: ['text', 'answer', 'finalAnswer', 'hints'],
      },
    },
  },
  required: ['questions'],
};

export async function generateHomework({ subject, topic, level, count, notes }) {
  const system = `You are an experienced teacher writing homework questions with built-in hints.
Write clear, self-contained questions appropriate for the stated level.
Each question must be answerable in a short written response (a sentence, a number, or a short working).
Vary the difficulty from easy to challenging. Do not number the questions in the text field.
Every question MUST end with an explicit instruction saying exactly how the answer should be written, for example:
"Give your answer as x = ..., y = ...", "Give your answer in pounds, e.g. £1.50", "Give your answers as coordinate pairs (x, y)",
"Give your answer to 2 decimal places", "Answer in one sentence". Choose the format that fits the question.
For each question write:
- a full worked model answer for the teacher;
- the final answer on its own, written exactly in the format the question asks for (e.g. "x = 7, y = 3");
- exactly ${HINTS_PER_QUESTION} hints a student can reveal one at a time, in order:
  1. a gentle nudge toward the relevant idea or first step,
  2. a more specific hint about the method or a common mistake,
  3. a nearly-there hint that walks them to the final step.
Hints must be 1-3 short, encouraging sentences suited to the level, and must NEVER state the final answer or make it obvious.`;

  const prompt = `Subject: ${subject}
Topic: ${topic}
Student level: ${level}
Number of questions: ${count}
${notes ? `Extra instructions from the teacher: ${notes}` : ''}`;

  const out = await askJson({ system, prompt, schema: homeworkSchema });
  return out.questions.slice(0, count).map((q) => ({
    text: q.text,
    answer: q.answer,
    finalAnswer: q.finalAnswer,
    hints: q.hints.slice(0, HINTS_PER_QUESTION),
  }));
}
