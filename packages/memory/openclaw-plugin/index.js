/**
 * Pentatonic Memory — OpenClaw Context Engine Plugin
 *
 * Install: openclaw plugins install @pentatonic-ai/openclaw-memory
 *
 * Provides persistent, searchable memory via the ContextEngine lifecycle:
 *   ingest   — every message stored with embedding + HyDE
 *   assemble — relevant memories injected before every prompt
 *   compact  — decay cycle on context overflow
 *   afterTurn — consolidation check
 *
 * Plus agent-callable tools: memory_search, memory_store, memory_layers
 */

export { default } from "@pentatonic-ai/ai-agent-sdk/memory/openclaw";
