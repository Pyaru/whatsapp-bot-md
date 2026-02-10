// --- START OF FILE index.js ---

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const fetch = require('node-fetch'); 
const fs = require('fs'); // ফাইল সিস্টেম মডিউল যুক্ত করা হলো
const app = express();

const phoneNumber = "8801865760508"; 
const adminNumber = "96897657655"; // এডমিন নম্বর (শুধু সংখ্যা)

// ==========================================
// 📊 কনফিগারেশন ও ডাটাবেস
// ==========================================

const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv"; 

let booksDatabase = []; 
const USER_DB_FILE = 'users.json'; // ইউজার ডাটাবেস ফাইল
let allUsers = new Set(); // মেমোরিতে ইউজার লিস্ট

// ইউজার ডাটাবেস লোড করা
if (fs.existsSync(USER_DB_FILE)) {
    try {
        const data = fs.readFileSync(USER_DB_FILE);
        allUsers = new Set(JSON.parse(data));
        console.log(`👥 পূর্ববর্তী ইউজার লোড হয়েছে: ${allUsers.size} জন`);
    } catch (e) {
        console.error("User DB Load Error:", e);
    }
}

// নতুন ইউজার সেভ করার ফাংশন
function saveUser(jid) {
    if (jid && !allUsers.has(jid) && !jid.includes("g.us")) { // গ্রুপ বাদ দিয়ে
        allUsers.add(jid);
        fs.writeFileSync(USER_DB_FILE, JSON.stringify([...allUsers]));
        console.log(`➕ নতুন ইউজার যুক্ত হয়েছে: ${jid}`);
    }
}

// গুগল শিট লোডার
async function loadBooksFromSheet() {
    try {
        console.log("📥 গুগল শিট থেকে বই আপডেট হচ্ছে...");
        const response = await fetch(SHEET_URL);
        const text = await response.text();
        const rows = text.split('\n'); 
        const newBooks = [];

        rows.forEach((row) => {
            const parts = row.split(','); 
            if (parts.length >= 2) {
                const name = parts[0].trim().replace(/"/g, ''); 
                const link = parts[1].trim();
                const category = parts[2] ? parts[2].trim().replace(/"/g, '') : "";
                if (link.startsWith('http')) {
                    newBooks.push({ name, link, category });
                }
            }
        });

        booksDatabase = newBooks;
        if (fuse) fuse.setCollection(booksDatabase);
        console.log(`✅ ${booksDatabase.length} টি বই আপলোড হয়েছে!`);
    } catch (error) {
        console.error("❌ বই লোড এরর:", error);
    }
}

// ==========================================
// 🛠️ মেইন লজিক ও ভেরিয়েবল
// ==========================================

const supportModeUsers = new Set();
const userSearchSessions = new Map();
const rateLimitMap = new Map(); // স্প্যাম প্রতিরোধের জন্য
const { extractBookKeyword, getGeminiReply } = require('./ai'); 

const fuseOptions = {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 3
};
let fuse = new Fuse([], fuseOptions);

const toEnglishDigits = (str) => str.replace(/[০-৯]/g, d => "0123456789"["০১২৩৪৫৬৭৮৯".indexOf(d)]);

const cleanUserQuery = (text) => {
    let cleaned = text.replace(/বইটা|বই|দেন|দিন|আছে|কি|চাই|রিসালা|কিতাব|পিডিএফ|pdf|book|download|link|টা/gi, "");
    cleaned = cleaned.replace(/নামাজ/g, "নামায"); 
    cleaned = cleaned.replace(/রমজান/g, "রমযান");
    cleaned = cleaned.replace(/ফয়জান/g, "ফয়যান");
    return cleaned.trim();
};

// ==========================================
// 🚀 কানেকশন লজিক
// ==========================================

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Islamic Bot", "Chrome", "2.0.0"], 
        syncFullHistory: true, 
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\nYour Pairing Code: ${code}\n`);
            } catch (err) { console.log("Pairing Code Error: ", err); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
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
        const senderNumber = remoteJid.split('@')[0];
        const incomingText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const msgLower = incomingText.toLowerCase();

        if (!incomingText) return; 

        // 🔥 ১. ইউজার সেভ করা (Broadcast এর জন্য)
        saveUser(remoteJid);

        // 🔥 ২. Anti-Spam (১.৫ সেকেন্ডের মধ্যে বারবার মেসেজ দিলে ইগনোর)
        const now = Date.now();
        const lastMsgTime = rateLimitMap.get(remoteJid) || 0;
        if (now - lastMsgTime < 1000) return; // ১ সেকেন্ড কুলডাউন
        rateLimitMap.set(remoteJid, now);

        // 🔥 ৩. ওয়েটিং রিয়েকশন (User Feedback)
        if (incomingText.length > 1) {
            await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });
        }

        // --- এডমিন কমান্ড ---
        
        // ক) আপডেট কমান্ড
        if ((msgLower === 'update' || msgLower === 'refresh') && senderNumber === adminNumber) {
            await sock.sendMessage(remoteJid, { text: "🔄 আপডেট হচ্ছে..." });
            await loadBooksFromSheet();
            await sock.sendMessage(remoteJid, { text: `✅ আপডেট সম্পন্ন! বই সংখ্যা: ${booksDatabase.length}` });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // খ) ব্রডকাস্ট কমান্ড (Admin Only) -> broadcast এই মেসেজটি সবার কাছে যাবে
        if (msgLower.startsWith('broadcast') && senderNumber === adminNumber) {
            const messageToSend = incomingText.replace(/broadcast/i, '').trim();
            if (!messageToSend) return sock.sendMessage(remoteJid, { text: "❌ মেসেজ লিখুন। উদাহরণ: broadcast নতুন বই এসেছে!" });

            await sock.sendMessage(remoteJid, { text: `📢 ${allUsers.size} জন ইউজারকে মেসেজ পাঠানো শুরু হচ্ছে...` });

            let count = 0;
            for (const userJid of allUsers) {
                try {
                    await new Promise(r => setTimeout(r, 1500)); // ১.৫ সেকেন্ড ডিলে (ব্যান ঠেকানোর জন্য)
                    await sock.sendMessage(userJid, { text: `📢 *নোটিফিকেশন:*\n\n${messageToSend}` });
                    count++;
                } catch (e) { console.log(`Failed: ${userJid}`); }
            }
            await sock.sendMessage(remoteJid, { text: `✅ সফলভাবে ${count} জনকে পাঠানো হয়েছে!` });
            return;
        }

        // --- সাধারণ ইউজার লজিক ---

        const adminKeywords = ['admin', 'এডমিন', 'help'];

if (adminKeywords.includes(msgLower)) {
    supportModeUsers.add(remoteJid);
    userSearchSessions.delete(remoteJid);
    await sock.sendMessage(remoteJid, {
        text: "🛑 সাপোর্ট মোড অন। এডমিন শীঘ্রই রিপ্লাই দেবেন। পুনরায় বট চালু করতে 'bot' লিখুন।"
    });
    return;
}
        const botKeywords = ['bot', 'বট', 'start'];

if (botKeywords.includes(msgLower)) {
    supportModeUsers.delete(remoteJid);
    await sock.sendMessage(remoteJid, {
        text: "✅ বট মোড চালু হয়েছে!"
    });
    return;
}
        if (supportModeUsers.has(remoteJid)) return;

// ---------------------------------------------
        // ৪. গ্রিটিংস বা মেইন মেনু (PRO ডিজাইন)
        // ---------------------------------------------
        const greetings = ["hi", "hello", "salam", "আসসালামু আলাইকুম", "সালাম", "হাই", "মেনু", "menu", "list", "তালিকা"];
        
        // লিস্ট বা মেনু চাইলে
        if (greetings.some(w => msgLower.startsWith(w)) && incomingText.length < 20) {
            
            // কেউ যদি শুধু তালিকা চায়
            if (msgLower.includes("list") || msgLower.includes("তালিকা")) {
                let listText = "📚 *ইসলামিক লাইব্রেরি - সকল বইয়ের তালিকা*\n\n";
                // ১০টার বেশি বই থাকলে টেক্সট ফাইলে দেব, কম থাকলে মেসেজে
                if (booksDatabase.length > 50) {
                     booksDatabase.forEach((book, index) => {
                        listText += `${index + 1}. ${book.name}\n`;
                    });
                    listText += "\n💡 যেকোনো বই পেতে সেই বইয়ের নম্বরটি লিখে মেসেজ দিন।";
                    const buffer = Buffer.from(listText, 'utf-8');
                    await sock.sendMessage(remoteJid, { 
                        document: buffer, 
                        mimetype: 'text/plain', 
                        fileName: 'Book_List.txt',
                        caption: '📂 সব বইয়ের তালিকা এখানে আছে।'
                    });
                } else {
                    // বই কম হলে সরাসরি মেসেজে দেখাবে
                    booksDatabase.forEach((book, index) => {
                        listText += `*${index + 1}.* ${book.name}\n`;
                    });
                    listText += "\n💡 বই পেতে নম্বরটি লিখুন।";
                    await sock.sendMessage(remoteJid, { text: listText });
                }
                await sock.sendMessage(remoteJid, { react: { text: "📜", key: msg.key } });
                return;
            }

            // মেইন মেনু ডিসপ্লে
            const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n\n` +
                             `🤖 *আমি মাকতাবা বট* - আপনার ইসলামিক সহকারী।\n\n` +
                             `🔍 *বই খুঁজতে:* দাওয়াতে ইসলামীর বইয়ের নাম লিখুন।\n` +
                             `📂 *সব বইয়ের নাম:* 'list' বা 'তালিকা' লিখুন।\n` +
                             `📝 *বই অনুরোধ:* 'request [বইয়ের নাম]' লিখুন।\n` +
                             `⁉️ *সাপোর্ট:* 'admin' লিখে মেসেজ দিন।\n` +
                             `🛑 *সার্চ বাতিল:* 'stop' লিখুন।\n\n` +
                             `💡 _যেকোনো ইসলামিক প্রশ্ন করতে পারেন, আমি উত্তর দেওয়ার চেষ্টা করব ইনশাআল্লাহ।_`;

            await sock.sendMessage(remoteJid, { text: menuText });
            await sock.sendMessage(remoteJid, { react: { text: "👋", key: msg.key } }); // সালাম বা ওয়েভ রিয়েকশন
            return;
        }

        if (["stop", "cancel", "clear", "শেষ"].includes(msgLower)) {
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ সার্চ ক্লিয়ার করা হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // রিকোয়েস্ট হ্যান্ডলিং
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই")) {
            await sock.sendMessage(adminNumber + "@s.whatsapp.net", { text: `🔔 Request: ${incomingText} \nFrom: ${remoteJid}` });
            await sock.sendMessage(remoteJid, { text: "✅ রিকোয়েস্ট এডমিনের কাছে পাঠানো হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // ---------------------------------------------
        // ৫. বই সিলেকশন হ্যান্ডলিং (সার্চ + মেইন লিস্ট)
        // ---------------------------------------------
        const convertedDigits = toEnglishDigits(incomingText);
        const isOnlyNumber = /^[0-9]+$/.test(convertedDigits);

        if (isOnlyNumber) {
            const selectedIndex = parseInt(convertedDigits) - 1;

            // ক) সার্চ সেশন চেক (আগে যদি সার্চ করে থাকে)
            if (userSearchSessions.has(remoteJid)) {
                const pendingBooks = userSearchSessions.get(remoteJid);
                
                if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                    const selectedBook = pendingBooks[selectedIndex];
                    
                    // 🔥 আগের সেই টেক্সট মেসেজ এখানে ফিরিয়ে আনা হলো
                    await sock.sendMessage(remoteJid, { text: `✅ *${selectedBook.name}* আপলোড হচ্ছে...` });

                    await sock.sendMessage(remoteJid, {
                        document: { url: selectedBook.link },
                        mimetype: 'application/pdf',
                        fileName: `${selectedBook.name}.pdf`
                    });
                    
                    // কাজ শেষে রিয়েকশন
                    await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                    return; 
                }
            }

            // খ) মেইন ডাটাবেস চেক (যদি সেশন না থাকে বা নম্বর সেশনের বাইরে হয়)
            if (selectedIndex >= 0 && selectedIndex < booksDatabase.length) {
                const globalBook = booksDatabase[selectedIndex];

                // 🔥 মেইন লিস্টের কনফার্মেশন মেসেজ ফিরিয়ে আনা হলো
                await sock.sendMessage(remoteJid, { 
                    text: `✅ তালিকা থেকে *${selectedIndex + 1}* নম্বর বইটি (${globalBook.name}) আপলোড হচ্ছে...` 
                });

                await sock.sendMessage(remoteJid, {
                    document: { url: globalBook.link },
                    mimetype: 'application/pdf',
                    fileName: `${globalBook.name}.pdf`
                });

                // কাজ শেষে রিয়েকশন
                await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                return;
            } 
            
            // যদি নম্বর ভুল দেয়
            else {
                await sock.sendMessage(remoteJid, { text: "❌ এই নম্বরের কোনো বই পাওয়া যায়নি। দয়া করে 'list' লিখে সঠিক নম্বর দেখুন অথবা 'stop' লিখে আবার চেষ্টা করুন।" });
                await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } });
                return;
            }
        }

        // স্মার্ট সার্চ এবং AI
        let searchQuery = cleanUserQuery(incomingText);
        let results = fuse.search(searchQuery);
        let matchingBooks = results.map(result => result.item);

        if (matchingBooks.length === 0) {
            // কীওয়ার্ড দিয়ে পুনরায় চেষ্টা
            const extractedKeyword = await extractBookKeyword(incomingText);
            if (extractedKeyword !== incomingText) {
                let keywordResults = fuse.search(cleanUserQuery(extractedKeyword));
                matchingBooks = keywordResults.map(result => result.item);
            }
        }

        if (matchingBooks.length > 0) {
            userSearchSessions.set(remoteJid, matchingBooks);
            let bookList = `🔍 *সম্ভাব্য ব‌ই পাওয়া গেছে:* (নম্বরটি লিখে রিপ্লাই দিন)\n\n`;
            const limit = Math.min(matchingBooks.length, 10);
            for(let i = 0; i < limit; i++) {
                bookList += `*${i + 1}.* ${matchingBooks[i].name}\n`;
            }
            await sock.sendMessage(remoteJid, { text: bookList });
            await sock.sendMessage(remoteJid, { react: { text: "📚", key: msg.key } });

        } else {
            // AI রিপ্লাই (মেমোরি সহ)
            await sock.sendPresenceUpdate('composing', remoteJid);
            // 🔥 remoteJid পাস করা হলো মেমোরির জন্য
            const aiResponse = await getGeminiReply(incomingText, remoteJid);
            await sock.sendMessage(remoteJid, { text: aiResponse });
            await sock.sendMessage(remoteJid, { react: { text: "🤖", key: msg.key } });
        }
    });
}

// সার্ভার স্টার্ট
loadBooksFromSheet();
setInterval(loadBooksFromSheet, 30 * 60 * 1000); // প্রতি ৩০ মিনিটে আপডেট

app.get('/', (req, res) => res.send('Pro Islamic Bot Running...'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));

connectToWhatsApp();