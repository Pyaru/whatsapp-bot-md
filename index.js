const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const fetch = require('node-fetch'); 
const fs = require('fs'); 
const app = express();

const phoneNumber = "8801865760508"; // আপনার বট নম্বর
const adminNumber = "228088717828220"; // আপনার এডমিন আইডি

// ==========================================
// 📊 কনফিগারেশন
// ==========================================
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv"; 
const PDF_LIST_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=456120804&single=true&output=pdf"; 

let booksDatabase = []; 
const USER_DB_FILE = 'users.json'; 
let allUsers = new Set(); 

// ইউজার ডাটাবেস লোড
if (!fs.existsSync(USER_DB_FILE)) {
    fs.writeFileSync(USER_DB_FILE, JSON.stringify([])); 
}
try {
    const data = fs.readFileSync(USER_DB_FILE);
    allUsers = new Set(JSON.parse(data));
} catch (e) {
    fs.writeFileSync(USER_DB_FILE, JSON.stringify([])); 
}

function saveUser(jid) {
    if (jid && !allUsers.has(jid) && !jid.includes("g.us")) { 
        allUsers.add(jid);
        fs.writeFileSync(USER_DB_FILE, JSON.stringify([...allUsers]));
    }
}

async function loadBooksFromSheet() {
    try {
        console.log("📥 বই লোড হচ্ছে...");
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
                const audio = parts[3] ? parts[3].trim() : ""; 
                if (link.startsWith('http')) newBooks.push({ name, link, category, audio });
            }
        });
        booksDatabase = newBooks;
        if (fuse) fuse.setCollection(booksDatabase);
        console.log(`✅ ${booksDatabase.length} টি বই লোড হয়েছে!`);
    } catch (error) { console.error("❌ বই লোড এরর:", error); }
}

// ==========================================
// 🛠️ মেইন লজিক
// ==========================================
const supportModeUsers = new Set();
const userSearchSessions = new Map();
const sessionTimers = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; 
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
    return cleaned.trim();
};

// ==========================================
// 🚀 কানেকশন (PAIRING CODE VERSION)
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // QR বন্ধ
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"], // ফিক্সড ব্রাউজার
        syncFullHistory: false, 
    });

    // 🔥 Pairing Code লজিক
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\nYour Pairing Code: ${code}\n`);
            } catch (err) {
                console.log("Pairing Code Error: ", err);
            }
        }, 5000); // ৫ সেকেন্ড পর কোড চাইবে
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
        const incomingText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const msgLower = incomingText.toLowerCase();

        if (!incomingText) return; 

        saveUser(remoteJid);
        const now = Date.now();
        const lastMsgTime = rateLimitMap.get(remoteJid) || 0;
        if (now - lastMsgTime < 1000) return; 
        rateLimitMap.set(remoteJid, now);

        if (incomingText.length > 1) await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });

        // এডমিন চেক
        if (msgLower === 'id' || msgLower === 'check') {
            await sock.sendMessage(remoteJid, { text: `🕵️ ID: ${remoteJid}` });
            return;
        }

        // আপডেট কমান্ড
        if ((msgLower === 'update' || msgLower === 'refresh') && remoteJid.includes(adminNumber)) {
            await sock.sendMessage(remoteJid, { text: "🔄 আপডেট হচ্ছে..." });
            await loadBooksFromSheet();
            await sock.sendMessage(remoteJid, { text: `✅ আপডেট সম্পন্ন! বই: ${booksDatabase.length}` });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // ❌ ব্রডকাস্ট সম্পূর্ণ বন্ধ (নিরাপত্তার জন্য)
        if (msgLower.startsWith('broadcast')) {
            await sock.sendMessage(remoteJid, { text: "⚠️ ব্রডকাস্ট ফিচারটি নিরাপত্তার কারণে বন্ধ রাখা হয়েছে।" });
            return;
        }

        if (['admin', 'এডমিন', 'help'].includes(msgLower)) {
            supportModeUsers.add(remoteJid);
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "🛑 সাপোর্ট মোড চালু। এডমিন শীঘ্রই যোগাযোগ করবেন।" });
            return;
        }
        if (['bot', 'বট', 'start'].includes(msgLower)) {
            supportModeUsers.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ বট চালু হয়েছে!" });
        }
        if (supportModeUsers.has(remoteJid)) return;

        if (["stop", "বাদ", "clear"].includes(msgLower)) {
            userSearchSessions.delete(remoteJid);
            userSearchSessions.delete(remoteJid + "_audio");
            if (sessionTimers.has(remoteJid)) clearTimeout(sessionTimers.get(remoteJid));
            sessionTimers.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ ক্লিয়ার।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // রিকোয়েস্ট
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই")) {
            await sock.sendMessage(adminNumber + "@s.whatsapp.net", { text: `🔔 Request: ${incomingText} \nFrom: ${remoteJid}` });
            await sock.sendMessage(remoteJid, { text: "✅ রিকোয়েস্ট পাঠানো হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // ১. নতুন বই (১৫টি + সেশন)
        const newBookKeywords = ["new book", "নতুন বই", "আপডেট বই"];
        if (newBookKeywords.some(key => msgLower.includes(key))) {
            const recentBooks = booksDatabase.slice(-15).reverse();
            userSearchSessions.set(remoteJid, recentBooks);
            
            // টাইমার সেট
            if (sessionTimers.has(remoteJid)) clearTimeout(sessionTimers.get(remoteJid));
            const timer = setTimeout(() => {
                userSearchSessions.delete(remoteJid);
                userSearchSessions.delete(remoteJid + "_audio");
                sessionTimers.delete(remoteJid);
            }, SESSION_TIMEOUT);
            sessionTimers.set(remoteJid, timer);

            let updateMsg = "🎉 *নতুন ১৫টি বই:*\n(বই পেতে নম্বর লিখে রিপ্লাই দিন)\n\n";
            recentBooks.forEach((book, index) => {
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                updateMsg += `✨ ${index + 1}. ${displayName}\n`;
            });
            await sock.sendMessage(remoteJid, { text: updateMsg });
            await sock.sendMessage(remoteJid, { react: { text: "🆕", key: msg.key } });
            return;
        }

        // ২. বই সিলেকশন
        const convertedDigits = toEnglishDigits(incomingText);
        const isOnlyNumber = /^[0-9]+$/.test(convertedDigits);

        if (isOnlyNumber) {
            const selectedIndex = parseInt(convertedDigits) - 1;
            let selectedBook = null;

            if (userSearchSessions.has(remoteJid)) {
                const pendingBooks = userSearchSessions.get(remoteJid);
                if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                    selectedBook = pendingBooks[selectedIndex];
                }
            } else if (selectedIndex >= 0 && selectedIndex < booksDatabase.length) {
                selectedBook = booksDatabase[selectedIndex];
            }

            if (selectedBook) {
                const displayName = selectedBook.category ? `${selectedBook.name} (${selectedBook.category})` : selectedBook.name;
                await sock.sendMessage(remoteJid, { text: `✅ *${displayName}* আপলোড হচ্ছে...` });
                await sock.sendMessage(remoteJid, { document: { url: selectedBook.link }, mimetype: 'application/pdf', fileName: `${selectedBook.name}.pdf` });
                if (selectedBook.audio && selectedBook.audio.startsWith('http')) {
                    userSearchSessions.set(remoteJid + "_audio", selectedBook.audio);
                    await sock.sendMessage(remoteJid, { text: `🎧 *অডিও আছে!* শুনতে চাইলে *'audio'* লিখুন।` });
                }
                await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                return;
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ সঠিক নম্বর দিন অথবা 'list' লিখুন।" });
                await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } });
                return;
            }
        }

        // ৩. অডিও
        if (msgLower === 'audio' || msgLower === 'অডিও') {
            const audioLink = userSearchSessions.get(remoteJid + "_audio");
            if (audioLink) {
                await sock.sendMessage(remoteJid, { text: "🎧 অডিও পাঠানো হচ্ছে..." });
                await sock.sendMessage(remoteJid, { audio: { url: audioLink }, mimetype: 'audio/mp4', ptt: false });
                await sock.sendMessage(remoteJid, { react: { text: "🎶", key: msg.key } });
            } else {
                await sock.sendMessage(remoteJid, { text: "⚠️ দুঃখিত! অডিও নেই।" });
            }
            return;
        }

        // সার্চ
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
            
            // টাইমার সেট
            if (sessionTimers.has(remoteJid)) clearTimeout(sessionTimers.get(remoteJid));
            const timer = setTimeout(() => {
                userSearchSessions.delete(remoteJid);
                userSearchSessions.delete(remoteJid + "_audio");
                sessionTimers.delete(remoteJid);
            }, SESSION_TIMEOUT);
            sessionTimers.set(remoteJid, timer);

            let bookList = `🔍 *পাওয়া গেছে:* (নম্বর দিন)\n\n`;
            const limit = Math.min(matchingBooks.length, 15); // ১৫টি বই দেখাবে
            for(let i = 0; i < limit; i++) {
                const book = matchingBooks[i];
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                bookList += `*${i + 1}.* ${displayName}\n`;
            }
            await sock.sendMessage(remoteJid, { text: bookList });
            await sock.sendMessage(remoteJid, { react: { text: "📚", key: msg.key } });
        } else {
            // ৪. মেনু ও গ্রিটিংস
            const greetings = ["hi", "hello", "salam", "আসসালামু আলাইকুম", "সালাম", "হাই", "হ্যালো", "মেনু", "menu", "list", "তালিকা"];
            
            if (greetings.some(w => msgLower.startsWith(w)) && incomingText.length < 25) {
                if (msgLower.includes("list") || msgLower.includes("তালিকা")) {
                    if (PDF_LIST_URL && PDF_LIST_URL.length > 10) {
                        await sock.sendMessage(remoteJid, { document: { url: PDF_LIST_URL }, mimetype: 'application/pdf', fileName: 'Book_List.pdf', caption: '📂 সকল বইয়ের তালিকা (PDF)' });
                        await sock.sendMessage(remoteJid, { react: { text: "📜", key: msg.key } });
                        return;
                    }
                    let listText = "📚 *সকল বইয়ের তালিকা*\n\n";
                    if (booksDatabase.length > 50) {
                        booksDatabase.forEach((book, index) => {
                            const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                            listText += `${index + 1}. ${displayName}\n`;
                        });
                        const buffer = Buffer.from(listText, 'utf-8');
                        await sock.sendMessage(remoteJid, { document: buffer, mimetype: 'text/plain', fileName: 'Book_List.txt', caption: '📂 সব বইয়ের তালিকা।' });
                    } else {
                        booksDatabase.forEach((book, index) => listText += `*${index + 1}.* ${book.name}\n`);
                        await sock.sendMessage(remoteJid, { text: listText });
                    }
                    await sock.sendMessage(remoteJid, { react: { text: "📜", key: msg.key } });
                    return;
                }
                const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n\n` +
                                 `🤖 *মাকতাবা বট*\n` +
                                 `🔍 *খুঁজতে:* বইয়ের নাম লিখুন।\n` +
                                 `📂 *সব বই:* 'list' বা 'তালিকা' লিখুন।\n` +
                                 `🆕 *নতুন:* 'নতুন বই' লিখুন।\n` +
                                 `📝 *অনুরোধ:* 'request [বই]' লিখুন।\n` +
                                 `⁉️ *সাপোর্ট:* 'admin' লিখুন।`;
                await sock.sendMessage(remoteJid, { text: menuText });
                await sock.sendMessage(remoteJid, { react: { text: "👋", key: msg.key } });
                return;
            }

            // গ) AI রিপ্লাই
            await sock.sendPresenceUpdate('composing', remoteJid);
            const aiResponse = await getGeminiReply(incomingText, remoteJid);
            await sock.sendMessage(remoteJid, { text: aiResponse });
            await sock.sendMessage(remoteJid, { react: { text: "🤖", key: msg.key } });
        }
    });
}

loadBooksFromSheet();
setInterval(loadBooksFromSheet, 30 * 60 * 1000); 
app.get('/', (req, res) => res.send('Bot Running with Pairing Code...'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));
connectToWhatsApp();
