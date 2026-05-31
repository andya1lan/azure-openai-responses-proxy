// ==================== Environment ====================

export interface Env {
  AZURE_ENDPOINT?: string;
  AZURE_API_VERSION?: string;
  AZURE_AUTH_HEADER?: string;
  AZURE_API_KEY?: string;
  DEFAULT_MODEL?: string;
  EXPOSED_MODELS?: string;
  ENABLE_STREAMING?: boolean | string;
  DEBUG_LOG?: boolean | string;
  API_KEY?: string;
}

// ==================== OpenAI Chat Completion ====================

export type ChatMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';

export interface ChatTextPart { type: 'text'; text: string }
export interface ChatImagePart { type: 'image_url'; image_url: { url: string; detail?: string } }
export type ChatContentPart = ChatTextPart | ChatImagePart | { type: string; [k: string]: any };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatMessageRole;
  content?: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  refusal?: string | null;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: any;
    strict?: boolean;
  };
}

export type ChatToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: any;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_logprobs?: number;
  logprobs?: boolean;
  stop?: string | string[];
  seed?: number;
  n?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  store?: boolean;
  metadata?: Record<string, string>;
  user?: string;
  [k: string]: any;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
    audio_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: {
      role: 'assistant';
      content: string | null;
      refusal?: string | null;
      tool_calls?: ChatToolCall[];
      reasoning_content?: string;
    };
    logprobs?: any;
  }>;
  usage?: ChatCompletionUsage;
  system_fingerprint?: string;
}

// ==================== OpenAI Responses API ====================

// --- Inputs ---

export interface ResponseInputTextPart { type: 'input_text'; text: string }
export interface ResponseInputImagePart {
  type: 'input_image';
  image_url?: string;
  file_id?: string;
  detail?: 'auto' | 'low' | 'high';
}
export interface ResponseInputFilePart {
  type: 'input_file';
  file_id?: string;
  filename?: string;
  file_data?: string;
}
export interface ResponseOutputTextPart {
  type: 'output_text';
  text: string;
  annotations?: any[];
  logprobs?: any;
}
export interface ResponseRefusalPart { type: 'refusal'; refusal: string }

export type ResponseContentPart =
  | ResponseInputTextPart
  | ResponseInputImagePart
  | ResponseInputFilePart
  | ResponseOutputTextPart
  | ResponseRefusalPart
  | { type: string; [k: string]: any };

export interface ResponseMessageItem {
  type: 'message';
  id?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  role: 'user' | 'system' | 'developer' | 'assistant';
  content: string | ResponseContentPart[];
}

export interface ResponseFunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
}

export interface ResponseFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface ResponseReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  encrypted_content?: string;
  status?: 'in_progress' | 'completed';
}

export type ResponseInputItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | ResponseFunctionCallOutputItem
  | ResponseReasoningItem
  | { type: string; [k: string]: any };

// --- Tool definition (flattened) ---

export interface ResponseFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: any;
  strict?: boolean;
}

export type ResponseTool = ResponseFunctionTool | { type: string; [k: string]: any };

export type ResponseToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; name: string }
  | { type: string; [k: string]: any };

// --- Request ---

export interface ResponsesRequest {
  model?: string;
  input: string | ResponseInputItem[];
  instructions?: string | null;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_logprobs?: number;

  tools?: ResponseTool[];
  tool_choice?: ResponseToolChoice;
  parallel_tool_calls?: boolean;
  max_tool_calls?: number;

  reasoning?: {
    effort?: 'minimal' | 'low' | 'medium' | 'high';
    summary?: 'auto' | 'concise' | 'detailed';
  };

  text?: {
    format?: any;
    verbosity?: 'low' | 'medium' | 'high';
  };

  truncation?: 'auto' | 'disabled';
  stream?: boolean;
  store?: boolean;
  background?: boolean;
  previous_response_id?: string | null;
  metadata?: Record<string, string>;
  user?: string;
  include?: string[];
  service_tier?: string;
  [k: string]: any;
}

// --- Response ---

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens: number;
}

export type ResponseOutputItem =
  | (ResponseMessageItem & { id: string; status: 'completed' | 'in_progress' | 'incomplete' })
  | (ResponseFunctionCallItem & { id: string })
  | (ResponseReasoningItem & { id: string });

export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'in_progress' | 'queued' | 'incomplete' | 'failed' | 'cancelled';
  error: null | { code: string; message: string };
  incomplete_details: null | { reason: string };
  model: string;
  instructions: string | null;
  previous_response_id: string | null;
  output: ResponseOutputItem[];
  output_text?: string;
  parallel_tool_calls?: boolean;
  tool_choice?: any;
  tools?: any[];
  temperature?: number;
  top_p?: number;
  top_logprobs?: number | null;
  max_output_tokens?: number | null;
  max_tool_calls?: number | null;
  reasoning?: any;
  text?: any;
  truncation?: string;
  background?: boolean;
  store?: boolean;
  service_tier?: string;
  metadata?: Record<string, string>;
  user?: string | null;
  usage?: ResponsesUsage;
}
