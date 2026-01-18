const fetch = require('node-fetch');

// ১. কথা বলার জন্য মেইন AI ফাংশন
async function getGeminiReply(userMessage) {
    try {
        const instruction = `
        তোমার পরিচয়: তুমি হলে একটি 'ইসলামিক লাইব্রেরি বট'।
        
        তোমার আচরণবিধি:
        ১. কেউ যদি "কেমন আছো", "তুমি কে", "তোমাকে কে বানিয়েছে", "কী করো" - এমন সাধারণ প্রশ্ন করে, তবে খুব সুন্দর করে ছোট করে বাংলায় উত্তর দাও।
           - তোমাকে বানিয়েছে: [আপনার নাম বা Pyaru Attari] (এটি বলবে)।
        
        ২. কেউ যদি সালাম দেয়, সুন্দর করে ওয়ালাইকুমুস সালাম বলবে।

        ৩. কিন্তু, কেউ যদি কোনো বইয়ের নাম বা টপিক লিখে (যেমন: "ফতোয়ায়ে শামি", "বুখারী শরীফ", "বাহারে শরীয়ত"), আর সেই বইটি আমার ডাটাবেসে পাওয়া না যায়, তখন তুমি কোনো পন্ডিতি করবে না বা বিস্তারিত তথ্য দেবে না।
           - সরাসরি বলবে: "⚠️ দুঃখিত, এই বইটি বা বিষয়টি আমার সংগ্রহে নেই। আপনি চাইলে 'request [নাম]' লিখে এডমিনকে জানাতে পারেন।"
        `;

        const prompt = encodeURIComponent(`${instruction}\n\nUser said: "${userMessage}"`);
        const url = `https://text.pollinations.ai/${prompt}?model=openai`;

        const response = await fetch(url);
        const text = await response.text();

        // ক্লিনিং
        try {
            const json = JSON.parse(text);
            if (json.content) return json.content;
            return text;
        } catch (e) {
            return text;
        }

    } catch (error) {
        console.error("AI Error:", error.message);
        return "দুঃখিত, আমি এখন কথা বলতে পারছি না।";
    }
}

// ২. কিওয়ার্ড বের করার ফাংশন (যেমন আছে তেমনই থাকবে)
async function extractBookKeyword(userText) {
    try {
        const instruction = `Extract the main book topic/keyword from this text in 1-2 words. Input: "${userText}"`;
        const prompt = encodeURIComponent(instruction);
        const url = `https://text.pollinations.ai/${prompt}?model=openai`;
        const response = await fetch(url);
        const text = await response.text();
        return text.trim().replace(/['"]+/g, '');
    } catch (error) {
        return userText;
    }
}

module.exports = { getGeminiReply, extractBookKeyword };