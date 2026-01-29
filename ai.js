0const fetch = require('node-fetch');
const googleIt = require('google-it');

// ============================================
// 🌐 কনফিগারেশন: আপনার কাঙ্খিত ওয়েবসাইটগুলোর তালিকা
// ============================================
const targetSites = [
    "dawateislami.net",
    "ilyasqadri.com",
    "dawateislami.org",
    "daruliftaahlesunnat.net"
];

// ============================================
// 🔍 ১. গুগল সার্চ ফাংশন (দাওয়াত-ই-ইসলামী ফোকাসড)
// ============================================
async function searchIslamicSites(query) {
    try {
        // সব সাইট মিলিয়ে সার্চ কুয়েরি তৈরি করা
        const siteQuery = targetSites.map(site => `site:${site}`).join(" OR ");
        const finalQuery = `${siteQuery} ${query}`;

        const results = await googleIt({
            query: finalQuery,
            limit: 4, // সেরা ৪টি রেজাল্ট নেবে
            disableConsole: true
        });

        if (!results || results.length === 0) return null;

        // রেজাল্টগুলো টেক্সট আকারে সাজানো
        return results.map(r => `Title: ${r.title}\nSnippet: ${r.snippet}`).join("\n\n");

    } catch (error) {
        console.error("Google Search Error:", error.message);
        return null;
    }
}

// ============================================
// 🤖 ২. মেইন AI রিপ্লাই ফাংশন
// ============================================
async function getGeminiReply(userMessage) {
    try {
        // --- ধাপ ১: সাধারণ কথাবার্তা চেক করা ---
        const greetings = ["hi", "hello", "salam", "kemon", "ke tumi", "ki koro", "কেমন", "হাই", "হ্যালো", "সালাম"];
        const isGreeting = greetings.some(g => userMessage.toLowerCase().includes(g));

        let prompt;

        if (isGreeting && userMessage.length < 20) {
            // সাধারণ কথাবার্তা
            prompt = `
            তুমি একজন বন্ধুসুলভ ইসলামিক লাইব্রেরি বট।
            ব্যবহারকারী বলেছে: "${userMessage}"
            তুমি ছোট করে সুন্দর বাংলায় উত্তর দাও। সালাম দিলে ওয়ালাইকুমুস সালাম বলবে।
            `;
        } else {
            // --- ধাপ ২: ধর্মীয় প্রশ্ন হলে সার্চ করা ---
            console.log(`Searching for: ${userMessage}`);
            const searchContext = await searchIslamicSites(userMessage);

            if (searchContext) {
                prompt = `
                Context form Islamic Websites:
                ${searchContext}

                User Question: "${userMessage}"

                Instructions:
                ১. উপরের 'Context' থেকে তথ্য নিয়ে ব্যবহারকারীর প্রশ্নের উত্তর দাও।
                ২. উত্তরটি অবশ্যই বাংলায় হবে।
                ৩. উত্তরটি গুছিয়ে পয়েন্ট আকারে বা প্যারা করে দেবে।
                ৪. যদি 'Context'-এ উত্তর না থাকে, তবে বিনীতভাবে বলো যে ওয়েবসাইটে তথ্য পাওয়া যায়নি।
                `;
            } else {
                return "⚠️ দুঃখিত, দাওয়াত-ই-ইসলামীর ভেরিফাইড ওয়েবসাইটগুলোতে এই বিষয়ে কোনো তথ্য খুঁজে পাইনি। বানান সঠিক কিনা যাচাই করুন অথবা এডমিনকে জানান।";
            }
        }

        // --- ধাপ ৩: AI এর কাছে পাঠানো ---
        // URL লিমিট এড়াতে প্রম্পট ছোট করা হচ্ছে
        const finalPrompt = encodeURIComponent(prompt.substring(0, 2500)); 
        const url = `https://text.pollinations.ai/${finalPrompt}?model=openai`;

        const response = await fetch(url);
        const text = await response.text();

        // --- ধাপ ৪: এরর হ্যান্ডলিং ---
        if (text.includes("Queue full") || text.includes('"error":')) {
            return "⚠️ সার্ভার ব্যস্ত। দয়া করে ২-৩ মিনিট পর আবার প্রশ্ন করুন।";
        }

        try {
            const json = JSON.parse(text);
            return json.content || text;
        } catch (e) {
            return text;
        }

    } catch (error) {
        console.error("AI Error:", error.message);
        return "সাময়িক যান্ত্রিক ত্রুটির কারণে উত্তর দেওয়া যাচ্ছে না।";
    }
}

// ============================================
// 🔑 ৩. কিওয়ার্ড বের করার ফাংশন
// ============================================
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