import { env } from '@config/env';
import logger from '@lib/logger';
import type { Socket } from 'socket.io';

export interface AIMessage {
  role:    'user' | 'assistant';
  content: string;
}

export interface AICompletionParams {
  system:     string;
  messages:   AIMessage[];
  max_tokens: number;
}

export interface AICompletionResult {
  text:          string;
  input_tokens:  number;
  output_tokens: number;
  provider:      'claude' | 'gemini';
  model:         string;
}

async function callClaude(params: AICompletionParams): Promise<AICompletionResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client    = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: params.max_tokens,
    system:     params.system,
    messages:   params.messages,
  });

  const content = response.content[0];
  if (content?.type !== 'text') {
    throw new Error('Claude returned unexpected response format');
  }

  return {
    text:          content.text,
    input_tokens:  response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    provider:      'claude',
    model:         'claude-opus-4-6',
  };
}

async function callGemini(params: AICompletionParams): Promise<AICompletionResult> {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to your .env file. ' +
      'Get a free key at https://aistudio.google.com',
    );
  }

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: params.system,
  });

  // Split messages into history (all except last) + current prompt
  const history = params.messages.slice(0, -1).map((m) => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const lastMessage = params.messages[params.messages.length - 1];
  if (!lastMessage) throw new Error('No messages provided to callGemini');

  const chat   = model.startChat({ history });
  const result = await chat.sendMessage(lastMessage.content);
  const text   = result.response.text();
  const usage  = result.response.usageMetadata;

  return {
    text,
    input_tokens:  usage?.promptTokenCount     ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0,
    provider:      'gemini',
    model:         'gemini-2.5-flash',
  };
}

async function streamGemini(
  params: AICompletionParams,
  onToken: (token: string) => void,
): Promise<{ text: string; input_tokens: number; output_tokens: number }> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: params.system,
  });

  const lastMessage = params.messages[params.messages.length - 1];
  if (!lastMessage) throw new Error('No messages provided');

  const result = await model.generateContentStream(lastMessage.content);

  let fullText = '';
  for await (const chunk of result.stream) {
    const token = chunk.text();
    if (token) {
      fullText += token;
      onToken(token);
    }
  }

  const finalResponse = await result.response;
  const usage         = finalResponse.usageMetadata;

  return {
    text:          fullText,
    input_tokens:  usage?.promptTokenCount     ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0,
  };
}

async function streamClaude(
  params: AICompletionParams,
  onToken: (token: string) => void,
): Promise<{ text: string; input_tokens: number; output_tokens: number }> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client    = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const stream = client.messages.stream({
    model:      'claude-opus-4-6',
    max_tokens: params.max_tokens,
    system:     params.system,
    messages:   params.messages,
  });

  let fullText = '';
  for await (const chunk of stream) {
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta.type === 'text_delta'
    ) {
      const token = chunk.delta.text;
      fullText   += token;
      onToken(token);
    }
  }

  const finalMessage = await stream.finalMessage();
  return {
    text:          fullText,
    input_tokens:  finalMessage.usage.input_tokens,
    output_tokens: finalMessage.usage.output_tokens,
  };
}

export async function callAI(params: AICompletionParams): Promise<AICompletionResult> {
  const provider = env.AI_PROVIDER ?? 'gemini';
  logger.debug({ provider }, 'AI completion request');

  if (provider === 'claude') {
    return callClaude(params);
  }
  return callGemini(params);
}

export async function streamFeedback(
  socket: Socket,
  params: AICompletionParams & {
    session_id:  string;
    question_id: string;
  },
): Promise<{ text: string; input_tokens: number; output_tokens: number; provider: string; model: string }> {
  const provider = env.AI_PROVIDER ?? 'gemini';

  const onToken = (token: string) => {
    socket.emit('quiz:answer_feedback', {
      token,
      session_id:  params.session_id,
      question_id: params.question_id,
      is_done:     false,
    });
  };

  let result: { text: string; input_tokens: number; output_tokens: number };

  if (provider === 'claude') {
    result = await streamClaude(params, onToken);
  } else {
    result = await streamGemini(params, onToken);
  }

  socket.emit('quiz:answer_feedback', {
    token:       '',
    session_id:  params.session_id,
    question_id: params.question_id,
    is_done:     true,
  });

  return {
    ...result,
    provider,
    model: provider === 'claude' ? 'claude-opus-4-6' : 'gemini-2.5-flash',
  };
}

export function getActiveProvider(): 'claude' | 'gemini' {
  return env.AI_PROVIDER ?? 'gemini';
}