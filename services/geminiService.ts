import { GoogleGenAI, Type } from "@google/genai";

const getClient = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
}

export const generateMeetingContext = async (topic: string): Promise<{ title: string; description: string }> => {
  const ai = getClient();
  if (!ai) {
    // Fallback if no API key
    return {
      title: topic || "General Discussion",
      description: "A secure video conference powered by Nebula Meet."
    };
  }

  try {
    const prompt = `Generate a professional and catchy meeting title and a brief 1-sentence description based on this topic: "${topic}".`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
          },
          required: ["title", "description"],
        }
      }
    });

    const text = response.text;
    if (text) {
        return JSON.parse(text);
    }
    throw new Error("No response text");

  } catch (error) {
    console.error("Gemini gen error:", error);
    return {
      title: topic || "Team Sync",
      description: "Discussing key items and action points."
    };
  }
};