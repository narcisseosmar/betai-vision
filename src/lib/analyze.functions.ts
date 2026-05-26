import { createServerFn } from "@tanstack/react-start";

type Match = {
  homeTeam: string;
  awayTeam: string;
  odd1: number;
  oddX: number;
  odd2: number;
};

export const analyzeBettingImage = createServerFn({ method: "POST" })
  .inputValidator((data: { imageDataUrl: string }) => {
    if (!data?.imageDataUrl || typeof data.imageDataUrl !== "string") {
      throw new Error("imageDataUrl is required");
    }
    if (!data.imageDataUrl.startsWith("data:image/")) {
      throw new Error("Invalid image data URL");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          {
            role: "system",
            content:
              "You extract football betting matches from screenshots of bookmaker odds. Return ONLY a JSON tool call with a list of matches. Each match has homeTeam, awayTeam, and three decimal odds: odd1 (home win), oddX (draw), odd2 (away win). Use European decimal format (e.g. 1.85). Skip rows that aren't a full 1X2 match.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract every match with 1, X, 2 odds visible in this image." },
              { type: "image_url", image_url: { url: data.imageDataUrl } },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "return_matches",
              description: "Return parsed football matches with 1X2 odds.",
              parameters: {
                type: "object",
                properties: {
                  matches: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        homeTeam: { type: "string" },
                        awayTeam: { type: "string" },
                        odd1: { type: "number" },
                        oddX: { type: "number" },
                        odd2: { type: "number" },
                      },
                      required: ["homeTeam", "awayTeam", "odd1", "oddX", "odd2"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["matches"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "return_matches" } },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429) throw new Error("Rate limit reached. Please wait a moment and try again.");
      if (res.status === 402) throw new Error("AI credits exhausted. Add credits in Settings > Workspace > Usage.");
      throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const call = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("AI did not return structured matches");
    let parsed: { matches: Match[] };
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch {
      throw new Error("Failed to parse AI response");
    }
    return { matches: parsed.matches ?? [] };
  });
