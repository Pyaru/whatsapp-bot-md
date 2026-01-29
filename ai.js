const fetch = require('node-fetch');

// ১. মেইন AI রিপ্লাই ফাংশন (Queue Full ফিক্সড)
async function getGeminiReply(userMessage) {
    try {
        const instruction = `
        তোমার পরিচয়: তুমি হলে একটি 'ইসলামিক লাইব্রেরি বট'।
        তোমার কাজ হলো ব্যবহারকারীদের প্রশ্নের সুন্দর ও মার্জিত ভাষায় উত্তর দেওয়া।
        
        শর্তসমূহ:
        ১. কেউ সালাম দিলে ওয়ালাইকুমুস সালাম বলবে।
        ২. সাধারণ প্রশ্ন করলে ছোট করে উত্তর দেবে।
        ৩. যদি কেউ বইয়ের নাম লিখে যা তোমার কাছে নেই, তবে বলবে: "দুঃখিত, এই বইটি আমার সংগ্রহে নেই।"
        `;

        const prompt = encodeURIComponent(`${instruction}\n\nUser said: "${userMessage}"`);
        
        // মডেল openai বা unity ব্যবহার করা হচ্ছে
        const url = `https://text.pollinations.ai/${prompt}?model=openai`;

        const response = await fetch(url);
        const text = await response.text();

        // 🔥 Queue Full / Error ফিক্সিং লজিক
        // সার্ভার থেকে আসা টেক্সটে যদি এই শব্দগুলো থাকে, তবে বাংলা মেসেজ দেখাবে
        if (text.includes("Queue full") || text.includes("too many requests") || text.includes('"error":')) {
            return "⚠️ দুঃখিত! এই মুহূর্তে সার্ভারে অতিরিক্ত চাপ (Traffic) রয়েছে। দয়া করে ২-৩ মিনিট পর আবার চেষ্টা করুন।";
        }

        // সাধারণ জেসন (JSON) প্রসেসিং
        try {
            const json = JSON.parse(text);
            if (json.content) return json.content;
            return text;
        } catch (e) {
            return text;
        }

    } catch (error) {
        console.error("AI Error:", error.message);
        return "দুঃখিত, সার্ভারে সমস্যা হচ্ছে। কিছুক্ষণ পর চেষ্টা করুন।";
    }
}

// ২. কিওয়ার্ড বের করার ফাংশন
async function extractBookKeyword(userText) {
    try {
        const instruction = `Extract only the main book name/topic from: "${userText}"`;
        const prompt = encodeURIComponent(instruction);
        const url = `https://text.pollinations.ai/${prompt}?model=openai`;
        const response = await fetch(url);
        const text = await response.text();

        if (text.includes("Queue full") || text.includes("error")) return userText;
        return text.trim().replace(/['"]+/g, '');
    } catch (error) {
        return userText;
    }
}

module.exports = { getGeminiReply, extractBookKeyword };