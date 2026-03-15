// --- START OF FILE ai.js ---
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// এখানে আপনার API Key দিন অথবা .env ফাইলে রাখুন
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "আপনার_জেহিনি_কী_এখানে_দিন");

// 💾 মেমোরি স্টোরেজ
const userHistory = new Map();
const MAX_HISTORY = 10; // Gemini ১০টি পর্যন্ত মেসেজ খুব ভালো মনে রাখতে পারে

/**
 * 🔄 মেমোরি ম্যানেজমেন্ট (Gemini Format)
 */
function updateHistory(userId, role, content) {
    if (!userHistory.has(userId)) {
        userHistory.set(userId, []);
        // ২০ মিনিট পর অটো ডিলিট (মেমোরি সেভ করার জন্য)
        setTimeout(() => userHistory.delete(userId), 1200000);
    }

    const history = userHistory.get(userId);
    // Gemini-তে বটের রোলকে 'model' বলা হয়
    const geminiRole = role === "assistant" ? "model" : "user";
    
    history.push({ role: geminiRole, parts: [{ text: content }] });

    if (history.length > MAX_HISTORY) {
        history.shift(); 
    }
}

/**
 * 🤖 মেইন AI রিপ্লাই ফাংশন
 */
async function getGeminiReply(userMessage, userId = "guest") {
    try {
        const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });

        // ১. সিস্টেম ইনস্ট্রাকশন
        const systemPrompt = `
        System Context:
        - Current Time in Bangladesh: ${now}
        - You are an 'Islamic Library Assistant' (Maktaba Bot).
        - Always reply in polite Bengali (বাংলা).
        - Start with "জি," or "অবশ্যই," for positive queries.
        - Keep answers concise (max 3-4 sentences).
        - Do NOT answer,  Islamic Sharia issues, Islamic fatwas, political or controversial topics.
        - If a book is missing, say: "দুঃখিত, এই বইটি আমার সংগ্রহে নেই।
        - তুমি 'মাকতাবা বট'। তোমার কাজ শুধু বই বা ইসলাম সম্পর্কিত প্রশ্নের উত্তর দেওয়া।
        `;

        // ২. মডেল কনফিগারেশন
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", // দ্রুত এবং ফ্রি মডেল
            systemInstruction: systemPrompt 
        });

        // ৩. চ্যাট হিস্ট্রি লোড করা
        const chat = model.startChat({
            history: userHistory.get(userId) || [],
            generationConfig: {
                maxOutputTokens: 500,
                temperature: 0.7,
            },
        });

        // ৪. মেসেজ পাঠানো
        const result = await chat.sendMessage(userMessage);
        const response = await result.response;
        const finalReply = response.text();

        // ৫. মেমোরি আপডেট (ইউজার এবং মডেল দুইটাই)
        updateHistory(userId, "user", userMessage);
        updateHistory(userId, "assistant", finalReply);

        return finalReply;

    } catch (error) {
        console.error("Gemini Error:", error);
        
        if (error.message.includes("429")) {
            return "⚠️ প্রতি মিনিটে মেসেজ পাঠানোর লিমিট শেষ হয়ে গেছে। দয়া করে কিছুক্ষণ পর চেষ্টা করুন।";
        }
        return "⚠️ দুঃখিত, কারিগরি সমস্যার কারণে উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।";
    }
}

/**
 * 🔍 কিওয়ার্ড বের করার ফাংশন (Gemini দিয়ে)
 */
async function extractBookKeyword(userText) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Extract ONLY the main book name from this text: "${userText}". Output only the name in Bengali. If no book name found, output "NULL".`;
        
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();

        if (text.includes("NULL")) return userText;
        return text.replace(/['"۔.]+/g, '');
    } catch (error) {
        return userText;
    }
}

module.exports = { getGeminiReply, extractBookKeyword };
