/**
 * 261010: the Ollama name heuristic (the fallback for when /api/show cannot
 * answer). It used to end in `return 'no'` over a stale list, so the most
 * popular local vision models were judged blind and Draw!/backseat locked.
 */
import { describe, it, expect } from 'vitest';
import { modelVision, ollamaVisionHeuristic } from './llmCatalog';

describe('ollamaVisionHeuristic', () => {
  it.each([
    'qwen2.5vl:3b',
    'qwen2.5vl:7b',
    'qwen3-vl:2b-instruct',
    'gemma3',
    'gemma3:4b',
    'gemma3:27b-it-qat',
    'gemma4:e4b',
    'llama3.2-vision:11b',
    'llama4:scout',
    'llava:7b',
    'llava-llama3',
    'bakllava',
    'moondream',
    'minicpm-v:8b',
    'granite3.2-vision',
    'mistral-small3.1:24b',
    'mistral-small3.2',
    'ministral-3:8b',
  ])('%s sees', (m) => {
    expect(ollamaVisionHeuristic(m)).toBe('yes');
    expect(modelVision('ollama', m)).toBe('yes');
  });

  it.each(['gemma3:1b', 'gemma3:270m'])('%s is a text-only gemma3 size', (m) => {
    expect(ollamaVisionHeuristic(m)).toBe('no');
  });

  it.each(['llama3.1', 'qwen2.5:0.5b', 'qwen3:1.7b', 'deepseek-r1:8b', 'gpt-oss:20b', 'hf.co/someone/model-GGUF:Q4_K_M'])(
    '%s is unknown (allowed through; /api/show decides)',
    (m) => {
      expect(ollamaVisionHeuristic(m)).toBe('unknown');
    },
  );

  it('a namespaced name is judged by its name, not its tag', () => {
    expect(ollamaVisionHeuristic('someone/llava-custom:latest')).toBe('yes');
    expect(ollamaVisionHeuristic('someone/text-model:vl-tag')).toBe('unknown');
  });
});
