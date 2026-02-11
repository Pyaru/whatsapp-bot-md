// --- START OF FILE index.js ---

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const fetch = require('node-fetch'); 
const fs = require('fs'); 
const app = express();

const phoneNumber = "8801865760508"; 
const adminNumber = "96897657655"; // এডমিন নম্বর (শুধু সংখ্যা, কান্ট্রি কোড সহ)

// ==========================================
// 📊 গুগল শিট ও ডাটাবেস কনফিগারেশন
// ==========================================

const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv"; 

let booksDatabase = []; 

// ইউজার ডাটাবেস ফাইল পাথ
const USER_DB_FILE = 'users.json'; 
let allUsers = new Set(); 

// ১. চেক করা ফাইল আছে কিনা, না থাকলে এখনই বানিয়ে ফেলবে
if (!fs.existsSync(USER_DB_FILE)) {
    fs.writeFileSync(USER_DB_FILE, JSON.stringify([])); 
    console.log("📄 নতুন users.json ফাইল তৈরি করা হয়েছে।");
}

// ২. ফাইল থেকে ডাটা লোড করা
try {
    const data = fs.readFileSync(USER_DB_FILE);
    allUsers = new Set(JSON.parse(data));
    console.log(`👥 মোট ইউজার লোড হয়েছে: ${allUsers.size} জন`);
} catch (e) {
    console.error("❌ ইউজার ডাটাবেস লোড এরর:", e);
    fs.writeFileSync(USER_DB_FILE, JSON.stringify([])); 
    allUsers = new Set();
}

// ৩. নতুন ইউজার সেভ করার ফাংশন
function saveUser(jid) {
    if (jid && !allUsers.has(jid) && !jid.includes("g.us")) { 
        allUsers.add(jid);
        fs.writeFileSync(USER_DB_FILE, JSON.stringify([...allUsers]));
        console.log(`➕ নতুন ইউজার যুক্ত হয়েছে: ${jid}`);
    }
}

// ৪. গুগল শিট লোডার ফাংশন
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
                // ৩য় কলামে ক্যাটাগরি (যদি থাকে)
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
const rateLimitMap = new Map(); 
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
// 🚀 মেইন কানেকশন লজিক
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

        // 🔥 ১. ইউজার সেভ (Broadcast এর জন্য)
        saveUser(remoteJid);

        // 🔥 ২. Anti-Spam (১ সেকেন্ড কুলডাউন)
        const now = Date.now();
        const lastMsgTime = rateLimitMap.get(remoteJid) || 0;
        if (now - lastMsgTime < 1000) return; 
        rateLimitMap.set(remoteJid, now);

        // 🔥 ৩. ওয়েটিং রিয়েকশন
        if (incomingText.length > 1) {
            await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });
        }

// =============================================
        // 🛠️ এডমিন কমান্ড (FIXED)
        // =============================================

        // ক) আপডেট কমান্ড (Admin Only)
        // 🔥 পরিবর্তন: senderNumber এর বদলে remoteJid.includes ব্যবহার করা হয়েছে
        if ((msgLower === 'update' || msgLower === 'refresh') && remoteJid.includes(adminNumber)) {
            await sock.sendMessage(remoteJid, { text: "🔄 গুগল শিট থেকে ডাটা আপডেট হচ্ছে..." });
            await loadBooksFromSheet();
            await sock.sendMessage(remoteJid, { text: `✅ আপডেট সম্পন্ন!\n📚 বর্তমানে মোট বই: ${booksDatabase.length} টি।` });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // খ) ব্রডকাস্ট কমান্ড (Admin Only)
        // 🔥 পরিবর্তন: এখানেও remoteJid.includes ব্যবহার করা হয়েছে
        if (msgLower.startsWith('broadcast') && remoteJid.includes(adminNumber)) {
            const messageToSend = incomingText.replace(/broadcast/i, '').trim();
            if (!messageToSend) return sock.sendMessage(remoteJid, { text: "❌ মেসেজ লিখুন। উদাহরণ: broadcast নতুন বই এসেছে!" });

            await sock.sendMessage(remoteJid, { text: `📢 ${allUsers.size} জন ইউজারকে মেসেজ পাঠানো শুরু হচ্ছে...` });

            let count = 0;
            for (const userJid of allUsers) {
                try {
                    await new Promise(r => setTimeout(r, 1500)); 
                    await sock.sendMessage(userJid, { text: `📢 *নোটিফিকেশন:*\n\n${messageToSend}` });
                    count++;
                } catch (e) { console.log(`Failed: ${userJid}`); }
            }
            await sock.sendMessage(remoteJid, { text: `✅ সফলভাবে ${count} জনকে পাঠানো হয়েছে!` });
            return;
        }

        // গ) সাপোর্ট মোড (Admin Chat)
        if (['admin', 'এডমিন', 'help'].includes(msgLower)) {
            supportModeUsers.add(remoteJid);
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "🛑 সাপোর্ট মোড অন। এডমিন শীঘ্রই রিপ্লাই দেবেন। পুনরায় বট চালু করতে 'bot' লিখুন।" });
            return;
        }

        // ঘ) বট মোড চালু
        if (['bot', 'বট', 'start'].includes(msgLower)) {
            supportModeUsers.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ বট মোড চালু হয়েছে!" });
            // start লিখলে মেনুও দেখাবে, তাই return দিচ্ছি না, নিচে যাবে...
        }

        // সাপোর্ট মোডে থাকলে এখান থেকেই ফিরে যাবে
        if (supportModeUsers.has(remoteJid)) return;

        // ঙ) ক্লিয়ার/স্টপ
        if (["stop", "cancel", "clear", "শেষ", "বাদ"].includes(msgLower)) {
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ সার্চ ক্লিয়ার করা হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // =============================================
        // 📚 ইউজার ফিচারস
        // =============================================

        // ১. নতুন বইয়ের তালিকা (What's New)
        const newBookKeywords = ["new book", "নতুন বই", "আপডেট বই", "নতুন কি বই", "update book", "latest books", "নতুন কি এসেছে"];
        if (newBookKeywords.some(key => msgLower.includes(key))) {
            const recentBooks = booksDatabase.slice(-10).reverse();
            if (recentBooks.length === 0) {
                await sock.sendMessage(remoteJid, { text: "⚠️ দুঃখিত, ডাটাবেসে কোনো বই পাওয়া যায়নি।" });
                return;
            }
            let updateMsg = "🎉 *আমাদের সংগ্রহের নতুন ১০টি বই:*\n\n";
            recentBooks.forEach((book, index) => {
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                updateMsg += `✨ ${index + 1}. ${displayName}\n`;
            });
            updateMsg += "\n💡 *বইটি পেতে:* বইয়ের নাম বা নম্বর লিখে সার্চ করুন।";
            await sock.sendMessage(remoteJid, { text: updateMsg });
            await sock.sendMessage(remoteJid, { react: { text: "🆕", key: msg.key } });
            return;
        }

        // ২. মেনু এবং গ্রিটিংস
        const greetings = ["hi", "hello", "salam", "আসসালামু আলাইকুম", "সালাম", "হাই", "মেনু", "menu", "list", "তালিকা", "start"];
        
        if (greetings.some(w => msgLower.startsWith(w)) && incomingText.length < 20) {
            
            // ক) ফুল লিস্ট
            if (msgLower.includes("list") || msgLower.includes("তালিকা")) {
                let listText = "📚 *ইসলামিক লাইব্রেরি - সকল বইয়ের তালিকা*\n\n";
                if (booksDatabase.length > 50) {
                     booksDatabase.forEach((book, index) => {
                        const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                        listText += `${index + 1}. ${displayName}\n`;
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
                    booksDatabase.forEach((book, index) => {
                        const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                        listText += `*${index + 1}.* ${displayName}\n`;
                    });
                    listText += "\n💡 বই পেতে নম্বরটি লিখুন।";
                    await sock.sendMessage(remoteJid, { text: listText });
                }
                await sock.sendMessage(remoteJid, { react: { text: "📜", key: msg.key } });
                return;
            }

            // খ) মেইন মেনু
            const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n\n` +
                             `🤖 *আমি মাকতাবা বট* - আপনার ইসলামিক সহকারী।\n\n` +
                             `🔍 *বই খুঁজতে:* দাওয়াতে ইসলামীর বইয়ের নাম লিখুন।\n` +
                             `📂 *সব বই:* 'list' বা 'তালিকা' লিখুন।\n` +
                             `🆕 *নতুন বই:* 'নতুন বই' লিখুন।\n` +
                             `📝 *বই অনুরোধ:* 'request [বইয়ের নাম]' লিখুন।\n` +
                             `⁉️ *সাপোর্ট:* 'admin' লিখে মেসেজ দিন।\n` +
                             `🛑 *সার্চ বাতিল:* 'stop' লিখুন।\n\n` +
                             `💡 _যেকোনো ইসলামিক প্রশ্ন করতে পারেন, আমি উত্তর দেওয়ার চেষ্টা করব ইনশাআল্লাহ।_`;

            await sock.sendMessage(remoteJid, { text: menuText });
            await sock.sendMessage(remoteJid, { react: { text: "👋", key: msg.key } });
            return;
        }

        // ৩. রিকোয়েস্ট হ্যান্ডলিং
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই")) {
            await sock.sendMessage(adminNumber + "@s.whatsapp.net", { text: `🔔 Request: ${incomingText} \nFrom: ${remoteJid}` });
            await sock.sendMessage(remoteJid, { text: "✅ রিকোয়েস্ট এডমিনের কাছে পাঠানো হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // ৪. নম্বর সিলেকশন ও ডাউনলোড
        const convertedDigits = toEnglishDigits(incomingText);
        const isOnlyNumber = /^[0-9]+$/.test(convertedDigits);

        if (isOnlyNumber) {
            const selectedIndex = parseInt(convertedDigits) - 1;

            // সার্চ সেশন চেক
            if (userSearchSessions.has(remoteJid)) {
                const pendingBooks = userSearchSessions.get(remoteJid);
                if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                    const selectedBook = pendingBooks[selectedIndex];
                    const displayName = selectedBook.category ? `${selectedBook.name} (${selectedBook.category})` : selectedBook.name;
                    
                    await sock.sendMessage(remoteJid, { text: `✅ *${displayName}* আপলোড হচ্ছে...` });
                    await sock.sendMessage(remoteJid, {
                        document: { url: selectedBook.link },
                        mimetype: 'application/pdf',
                        fileName: `${selectedBook.name}.pdf`
                    });
                    await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                    return; 
                }
            }

            // মেইন তালিকা চেক
            if (selectedIndex >= 0 && selectedIndex < booksDatabase.length) {
                const globalBook = booksDatabase[selectedIndex];
                const displayName = globalBook.category ? `${globalBook.name} (${globalBook.category})` : globalBook.name;

                await sock.sendMessage(remoteJid, { text: `✅ তালিকা থেকে *${selectedIndex + 1}* নম্বর বইটি (${displayName}) আপলোড হচ্ছে...` });
                await sock.sendMessage(remoteJid, {
                    document: { url: globalBook.link },
                    mimetype: 'application/pdf',
                    fileName: `${globalBook.name}.pdf`
                });
                await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                return;
            } 
            
            else {
                await sock.sendMessage(remoteJid, { text: "❌ এই নম্বরের কোনো বই পাওয়া যায়নি। দয়া করে 'list' লিখে সঠিক নম্বর দেখুন অথবা 'stop' লিখে আবার চেষ্টা করুন।" });
                await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } });
                return;
            }
        }

        // ৫. সার্চ এবং AI
        let searchQuery = cleanUserQuery(incomingText);
        let results = fuse.search(searchQuery);
        let matchingBooks = results.map(result => result.item);

        if (matchingBooks.length === 0) {
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
                const book = matchingBooks[i];
                // 🔥 ফিক্সড: ক্যাটাগরি সহ নাম দেখাবে
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                bookList += `*${i + 1}.* ${displayName}\n`;
            }
            bookList += `\n💡 বই পেতে নম্বরটি লিখুন।`;

            await sock.sendMessage(remoteJid, { text: bookList });
            await sock.sendMessage(remoteJid, { react: { text: "📚", key: msg.key } });

        } else {
            // AI রিপ্লাই
            await sock.sendPresenceUpdate('composing', remoteJid);
            const aiResponse = await getGeminiReply(incomingText, remoteJid);
            await sock.sendMessage(remoteJid, { text: aiResponse });
            await sock.sendMessage(remoteJid, { react: { text: "🤖", key: msg.key } });
        }
    });
}

// সার্ভার স্টার্ট
loadBooksFromSheet();
setInterval(loadBooksFromSheet, 30 * 60 * 1000); 

app.get('/', (req, res) => res.send('Pro Islamic Bot Running...'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));

connectToWhatsApp();