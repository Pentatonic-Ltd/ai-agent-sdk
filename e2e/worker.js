import { TESClient } from "../src/index.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

export default {
  async fetch(request, env) {
    if (!env.TES_ENDPOINT) throw new Error("TES_ENDPOINT env var is required");
    if (!env.TES_API_KEY) throw new Error("TES_API_KEY env var is required");
    if (!env.TES_CLIENT_ID) throw new Error("TES_CLIENT_ID env var is required");

    const tesEndpoint = env.TES_ENDPOINT;
    const tesApiKey = env.TES_API_KEY;
    const tesClientId = env.TES_CLIENT_ID;

    const tes = new TESClient({
      clientId: tesClientId,
      apiKey: tesApiKey,
      endpoint: tesEndpoint,
    });

    const results = {};

    // Test 1: Manual session with Workers AI
    try {
      const session = tes.session({
        sessionId: `e2e-manual-${Date.now()}`,
        metadata: { test: "manual-session" },
      });

      const r1 = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: "You are helpful. Reply in one sentence.",
          },
          { role: "user", content: "What is 2+2?" },
        ],
      });
      session.record(r1);

      const response =
        r1.response || r1.choices?.[0]?.message?.content || "";

      await session.emitChatTurn({
        userMessage: "What is 2+2?",
        assistantResponse: response,
      });

      results.manualSession = {
        pass: true,
        usage: session.totalUsage,
        response: response.slice(0, 100),
      };
    } catch (err) {
      results.manualSession = { pass: false, error: err.message };
    }

    // Test 2: Wrapped client via OpenAI-compatible shim over Workers AI
    try {
      const openaiCompat = {
        chat: {
          completions: {
            create: async (params) => {
              const aiResult = await env.AI.run(params.model || MODEL, {
                messages: params.messages,
              });
              return {
                choices: [
                  {
                    message: {
                      content:
                        aiResult.response ||
                        aiResult.choices?.[0]?.message?.content ||
                        "",
                    },
                  },
                ],
                usage: aiResult.usage || {},
                model: params.model || MODEL,
              };
            },
          },
        },
      };

      const ai = tes.wrap(openaiCompat);
      const result = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "user", content: "Say hello in French, one word only." },
        ],
      });

      // Wait for fire-and-forget emit
      await new Promise((r) => setTimeout(r, 500));

      results.wrappedClient = {
        pass: true,
        response: result.choices[0].message.content.slice(0, 100),
      };
    } catch (err) {
      results.wrappedClient = { pass: false, error: err.message };
    }

    return new Response(JSON.stringify(results, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
