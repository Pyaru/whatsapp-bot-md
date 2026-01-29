const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const app = express();

const phoneNumber = "8801865760508"; 
const adminNumber = "96897657655@s.whatsapp.net"; // 👈 আপনার এডমিন নম্বর

const supportModeUsers = new Set();
const userSearchSessions = new Map();

// বইয়ের ডাটাবেস লোড
const booksPart1 = require('./books.json');
const booksDatabase = [...booksPart1]; 

const { extractBookKeyword, getGeminiReply } = require('./ai'); 

// ==========================================
// 🛠️ কনফিগারেশন এবং হেল্পার ফাংশন
// ==========================================

// ১. ফাজি সার্চ কনফিগারেশন (আপডেট করা হয়েছে)
const fuseOptions = {
    keys: ['name'],
    threshold: 0.4, // ০.৩ থেকে বাড়িয়ে ০.৪ করা হলো (বানান ভুল আরও ভালোভাবে ধরবে)
    includeScore: true,
    ignoreLocation: true, // 👈 এটি নতুন! শব্দের আগে-পিছে যা-ই থাকুক, ম্যাচ করবে
    minMatchCharLength: 3 // অন্তত ৩ অক্ষর মিলতে হবে
};
const fuse = new Fuse(booksDatabase, fuseOptions);

// ২. বাংলা সংখ্যাকে ইংরেজিতে রূপান্তর
const toEnglishDigits = (str) => {
    return str.replace(/[০-৯]/g, d => "0123456789"["০১২৩৪৫৬৭৮৯".indexOf(d)]);
};

// ৩. ইউজারের টেক্সট ক্লিন করার ফাংশন (নতুন যোগ করা হয়েছে)
const cleanUserQuery = (text) => {
    // বই, দেন, চাই, পিডিএফ, রিসালা - এই শব্দগুলো মুছে ফেলবে
    let cleaned = text.replace(/বইটা|বই|দেন|দিন|আছে|কি|চাই|রিসালা|কিতাব|পিডিএফ|pdf|book|download|link|টা/gi, "");
    
    // বানান ঠিক করা (কমন ভুলগুলো)
    // আপনার ডাটাবেসে যদি 'নামায' থাকে, আর ইউজার 'নামাজ' লেখে, এটি ঠিক করে দেবে
    cleaned = cleaned.replace(/নামাজ/g, "নামায"); 
    
    return cleaned.trim();
};

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["WhatsApp Bot", "Firefox", "1.0.0"], 
        syncFullHistory: true, 
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\nYour Pairing Code: ${code}\n`);
            } catch (err) {
                console.log("Error requesting pairing code: ", err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp কানেক্টেড!');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const incomingText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const msgLower = incomingText.toLowerCase();

        if (!incomingText) return; 

        // --- কমান্ড হ্যান্ডলিং ---
        if (msgLower === 'admin' || msgLower === 'help') {
            supportModeUsers.add(remoteJid);
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "🛑 *সাপোর্ট মোড অন!* এডমিন শীঘ্রই রিপ্লাই দেবেন।" });
            return;
        }
        if (msgLower === 'bot' || msgLower === 'start') {
            supportModeUsers.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ *বট চালু হয়েছে!*" });
            return;
        }
        if (supportModeUsers.has(remoteJid)) return;

        // --- মেনু / গ্রিটিংস (সবার আগে চেক করবে) ---
        const greetings = ["hi", "hello", "salam", "আসসালামু", "সালাম", "হাই", "হ্যালো", "menu", "মেনু"];
        
        if (greetings.includes(msgLower) || (greetings.some(w => msgLower.includes(w)) && incomingText.length < 10)) {
            const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n\n` +
                             `🔍 *বই খুঁজতে:* নাম লিখুন (ভুল বানানেও সমস্যা নেই)।\n` +
                             `📝 *বই রিকোয়েস্ট:* 'চাই [বইয়ের নাম]' লিখুন।\n` +
                             `❓ *সাহায্য:* 'admin' লিখুন।`;
            await sock.sendMessage(remoteJid, { text: menuText });
            return;
        }

        // --- রিকোয়েস্ট ---
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই") || msgLower.startsWith("রিকোয়েস্ট")) {
            const requestedBook = incomingText.replace(/request|চাই|রিকোয়েস্ট/i, "").trim();
            if (adminNumber.includes("968")) {
                await sock.sendMessage(adminNumber, { text: `🔔 *Request:* ${requestedBook}\nFrom: ${remoteJid.split('@')[0]}` });
            }
            await sock.sendMessage(remoteJid, { text: "✅ রিকোয়েস্ট পাঠানো হয়েছে।" });
            return;
        }

        // --- সিলেকশন (১, ২, ৩...) ---
        const convertedText = toEnglishDigits(incomingText);
        if (userSearchSessions.has(remoteJid) && !isNaN(convertedText)) {
            const selectedIndex = parseInt(convertedText) - 1;
            const pendingBooks = userSearchSessions.get(remoteJid);

            if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                const selectedBook = pendingBooks[selectedIndex];
                await sock.sendMessage(remoteJid, { text: `✅ *${selectedBook.name}* আপলোড হচ্ছে...` });
                await sock.sendMessage(remoteJid, {
                    document: { url: selectedBook.link },
                    mimetype: 'application/pdf',
                    fileName: `${selectedBook.name}.pdf`
                });
                userSearchSessions.delete(remoteJid);
                return;
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ তালিকায় এই নম্বরটি নেই।" });
                return;
            }
        }

        // ==========================================
        // 🔥 ফাজি সার্চ লজিক (উন্নত করা হয়েছে)
        // ==========================================
        
        // ১. প্রথমে লেখাটি ক্লিন করা হলো (বইটা, দেন, রিসালা - বাদ দেওয়া হলো)
        let searchQuery = cleanUserQuery(incomingText);

        // যদি ক্লিন করার পর কিছু না থাকে (শুধু 'বই দেন' লিখলে), মেইন টেক্সট রাখবে
        if (!searchQuery) searchQuery = incomingText;

        // ২. খুব ছোট শব্দ হলে সার্চ করবে না (AI এর কাছে পাঠাবে)
        if (searchQuery.length < 2) {
             const aiResponse = await getGeminiReply(incomingText);
             await sock.sendMessage(remoteJid, { text: aiResponse });
             return;
        }

        // ৩. ক্লিন করা টেক্সট দিয়ে সার্চ
        let results = fuse.search(searchQuery);
        let matchingBooks = results.map(result => result.item);

        // ৪. যদি ক্লিন করার পরেও না পায়, তখন অরিজিনাল বা কিওয়ার্ড দিয়ে খুঁজবে
        if (matchingBooks.length === 0) {
            // ক্লিন ছাড়া অরিজিনাল টেক্সট দিয়ে একবার চেষ্টা
            let rawResults = fuse.search(incomingText);
            let rawMatches = rawResults.map(result => result.item);
            
            if (rawMatches.length > 0) {
                matchingBooks = rawMatches;
            } else {
                // তাতেও না পেলে AI কিওয়ার্ড এক্সট্রাকশন
                const extractedKeyword = await extractBookKeyword(incomingText);
                
                // কিওয়ার্ড দিয়ে আবার ক্লিন করে সার্চ
                let keywordCleaned = cleanUserQuery(extractedKeyword);
                if (keywordCleaned.length > 2 && keywordCleaned !== searchQuery) {
                    let keywordResults = fuse.search(keywordCleaned);
                    matchingBooks = keywordResults.map(result => result.item);
                }
            }
        }

        // রেজাল্ট প্রসেসিং
        if (matchingBooks.length > 0) {
            userSearchSessions.set(remoteJid, matchingBooks);
            
            let bookList = `🔍 *সম্ভাব্য বই পাওয়া গেছে:* \n(নিচের তালিকা থেকে নম্বর লিখুন)\n\n`;
            const limit = Math.min(matchingBooks.length, 5); 
            
            for(let i = 0; i < limit; i++) {
                bookList += `*${i + 1}.* ${matchingBooks[i].name}\n`;
            }
            if(matchingBooks.length === 1) {
                bookList += `\n💡 *1* লিখে রিপ্লাই দিন।`;
            }
            await sock.sendMessage(remoteJid, { text: bookList });

        } else {
            // 🛑 বই না পেলে AI এর কাছে পাঠাবে
            await sock.sendPresenceUpdate('composing', remoteJid);
            const aiResponse = await getGeminiReply(incomingText);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

app.get('/', (req, res) => res.send('Bot is Running'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));

connectToWhatsApp();