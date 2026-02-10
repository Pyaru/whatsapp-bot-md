// --- START OF FILE ai.js ---

const fetch = require('node-fetch');

// 💾 মেমোরি স্টোরেজ (Temporary Memory)
const userHistory = new Map();
const MAX_HISTORY = 6; // পেছনের ৬টি মেসেজ মনে রাখবে

/**
 * 🔄 মেমোরি ম্যানেজমেন্ট
 * ১০ মিনিট পর ইউজারের মেমোরি মুছে ফেলবে যাতে RAM ফ্রি থাকে
 */
function updateHistory(userId, role, content) {
    if (!userHistory.has(userId)) {
        userHistory.set(userId, []);
        // ১০ মিনিট (600000 ms) পর অটো ডিলিট
        setTimeout(() => userHistory.delete(userId), 600000);
    }

    const history = userHistory.get(userId);
    history.push({ role, content });

    if (history.length > MAX_HISTORY) {
        history.shift(); // পুরনো মেসেজ ডিলিট
    }
}

/**
 * 🤖 মেইন AI রিপ্লাই ফাংশন (Context + Time Awareness + Retry)
 */
async function getGeminiReply(userMessage, userId = "guest") {
    // ১. বর্তমান সময় বের করা (বাংলাদেশ সময়)
    const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });

    // ২. সিস্টেম ইনস্ট্রাকশন (বটের পার্সোনালিটি)
    const systemPrompt = `
    System Context:
    - Current Time in Bangladesh: ${now}
    - You are an 'Islamic Library Assistant' bot (Assistent).
    - Your name is 'Maktaba Bot'.
    
    Instructions:
    1. Always reply in polite Bengali (বাংলা).
    2. Start with "জি," or "অবশ্যই," for positive queries.
    3. If asked about time/date, use the Current Time provided above.
    4. Keep answers concise (maximum 3-4 sentences).
    5. Do NOT answer political/controversial topics.
    6. If a book is missing, say: "দুঃখিত, এই বইটি আমার সংগ্রহে নেই।"
    `;

    // ৩. মেসেজ অ্যারে তৈরি (System + History + New Message)
    let messages = [{ role: "system", content: systemPrompt }];
    
    if (userHistory.has(userId)) {
        messages = messages.concat(userHistory.get(userId));
    }
    messages.push({ role: "user", content: userMessage });

    // ৪. API কল (Retry Logic সহ)
    const models = ['openai', 'searchgpt']; // ব্যাকআপ মডেল
    
    for (const model of models) {
        try {
            const response = await fetch(`https://text.pollinations.ai/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: messages,
                    model: model,
                    seed: Math.floor(Math.random() * 1000)
                })
            });

            if (!response.ok) continue; // ফেইল হলে পরের মডেলে যাবে

            const text = await response.text();
            
            // এরর চেক
            if (text.includes("Queue full") || text.includes("Too many requests") || text.length < 2) {
                continue;
            }

            // সফল রেসপন্স ক্লিন করা
            const finalReply = text.replace(/['"]+/g, '').trim();

            // মেমোরি আপডেট
            updateHistory(userId, "user", userMessage);
            updateHistory(userId, "assistant", finalReply);

            return finalReply;

        } catch (error) {
            console.error(`Model ${model} failed:`, error.message);
        }
    }

    return "⚠️ দুঃখিত! সার্ভারে অতিরিক্ত চাপের কারণে উত্তর দেওয়া যাচ্ছে না। দয়া করে ২ মিনিট পর আবার চেষ্টা করুন।";
}

/**
 * 🔍 কিওয়ার্ড বের করার ফাংশন (Strict Mode)
 */
async function extractBookKeyword(userText) {
    try {
        const prompt = `
        Task: Extract ONLY the book name or main topic from: "${userText}".
        Output: Just the name in Bengali. No extra words. If unsure, return "NULL".
        `;
        
        const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai`;
        const response = await fetch(url);
        const text = await response.text();

        if (text.includes("Queue full") || text.includes("error") || text.includes("NULL")) return userText;
        return text.trim().replace(/['"۔.]+/g, '');
    } catch (error) {
        return userText;
    }
}

module.exports = { getGeminiReply, extractBookKeyword };