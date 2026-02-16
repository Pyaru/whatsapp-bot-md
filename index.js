const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const fetch = require('node-fetch'); 
const fs = require('fs'); 
const qrcode = require('qrcode-terminal'); // QR দেখানোর জন্য
const app = express();

const phoneNumber = "8801865760508"; 
const adminNumber = "96897657655"; // এডমিন নম্বর

// ==========================================
// 📊 কনফিগারেশন
// ==========================================
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv"; 
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
                if (link.startsWith('http')) newBooks.push({ name, link, category });
            }
        });
        booksDatabase = newBooks;
        if (fuse) fuse.setCollection(booksDatabase);
        console.log(`✅ ${booksDatabase.length} টি বই আপলোড হয়েছে!`);
    } catch (error) { console.error("❌ বই লোড এরর:", error); }
}

// ==========================================
// 🛠️ মেইন লজিক
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
    return cleaned.trim();
};

// ==========================================
// 🚀 কানেকশন (QR CODE VERSION)
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // ✅ QR কোড অন করা হলো
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false, 
    });

    // ❌ Pairing Code বাদ দেওয়া হয়েছে, তাই কোড আসবে না, QR আসবে

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

        saveUser(remoteJid);
        const now = Date.now();
        const lastMsgTime = rateLimitMap.get(remoteJid) || 0;
        if (now - lastMsgTime < 1000) return; 
        rateLimitMap.set(remoteJid, now);

        if (incomingText.length > 1) await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });

=============================================
        // 🕵️ এডমিন আইডি বের করার যন্তর (DEBUG TOOL)
        // =============================================
        
        // শুধু 'id' বা 'check' লিখলে বট আপনার আসল আইডি বলে দেবে
        if (msgLower === 'id' || msgLower === 'check') {
            await sock.sendMessage(remoteJid, { 
                text: `🕵️ *বট আপনাকে যে আইডিতে দেখছে:*\n\nID: ${remoteJid}\n\n(এই আইডিটি কপি করে adminNumber এ বসালে সব কমান্ড কাজ করবে)` 
            });
            return;
        }
        
        if ((msgLower === 'update' || msgLower === 'refresh') && remoteJid.includes(adminNumber)) {
            await sock.sendMessage(remoteJid, { text: "🔄 আপডেট হচ্ছে..." });
            await loadBooksFromSheet();
            await sock.sendMessage(remoteJid, { text: `✅ আপডেট সম্পন্ন! বই: ${booksDatabase.length}` });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        if (msgLower.startsWith('broadcast') && remoteJid.includes(adminNumber)) {
            const messageToSend = incomingText.replace(/broadcast/i, '').trim();
            if (!messageToSend) return sock.sendMessage(remoteJid, { text: "❌ মেসেজ দিন। উদাহরণ: broadcast নতুন ১০টি ব‌ই যুক্ত হয়েছে" });
            await sock.sendMessage(remoteJid, { text: `📢 ${allUsers.size} জনকে পাঠানো হচ্ছে...` });
            let count = 0;
            for (const userJid of allUsers) {
                try { await new Promise(r => setTimeout(r, 1500)); await sock.sendMessage(userJid, { text: `📢 *নোটিফিকেশন:*\n\n${messageToSend}` }); count++; } catch (e) {}
            }
            await sock.sendMessage(remoteJid, { text: `✅ সম্পন্ন: ${count} জন।` });
            return;
        }

        if (['admin', 'এডমিন', 'help'].includes(msgLower)) {
            supportModeUsers.add(remoteJid);
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "🛑 সাপোর্ট মোড চালু হয়েছে, এডমিন শিঘ্রই আপনার সাথে যোগাযোগ করবেন, পুনরায় বট চালু করার জন্য bot, বা start লিখুন।" });
            return;
        }
        if (['bot', 'বট', 'start'].includes(msgLower)) {
            supportModeUsers.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ বট চালু হয়েছে!" });
        }
        if (supportModeUsers.has(remoteJid)) return;

        if (["stop", "বাদ", "clear"].includes(msgLower)) {
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ ক্লিয়ার।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // রিকোয়েস্ট
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই")) {
            await sock.sendMessage(adminNumber + "@s.whatsapp.net", { text: `🔔 Request: ${incomingText} \nFrom: ${remoteJid}` });
            await sock.sendMessage(remoteJid, { text: "✅ এডমিনকে রিকোয়েস্ট পাঠানো হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // নতুন বই
        const newBookKeywords = ["new book", "নতুন বই", "আপডেট বই"];
        if (newBookKeywords.some(key => msgLower.includes(key))) {
            const recentBooks = booksDatabase.slice(-10).reverse();
            let updateMsg = "🎉 *নতুন ১০টি বই:*\n\n";
            recentBooks.forEach((book, index) => {
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                updateMsg += `✨ ${index + 1}. ${displayName}\n`;
            });
            await sock.sendMessage(remoteJid, { text: updateMsg });
            await sock.sendMessage(remoteJid, { react: { text: "🆕", key: msg.key } });
            return;
        }

        // বই ডাউনলোড
        const convertedDigits = toEnglishDigits(incomingText);
        const isOnlyNumber = /^[0-9]+$/.test(convertedDigits);
        if (isOnlyNumber) {
            const selectedIndex = parseInt(convertedDigits) - 1;
            if (userSearchSessions.has(remoteJid)) {
                const pendingBooks = userSearchSessions.get(remoteJid);
                if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                    const selectedBook = pendingBooks[selectedIndex];
                    const displayName = selectedBook.category ? `${selectedBook.name} (${selectedBook.category})` : selectedBook.name;
                    await sock.sendMessage(remoteJid, { text: `✅ *${displayName}* আপলোড হচ্ছে...` });
                    await sock.sendMessage(remoteJid, { document: { url: selectedBook.link }, mimetype: 'application/pdf', fileName: `${selectedBook.name}.pdf` });
                    await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                    return; 
                }
            }
            if (selectedIndex >= 0 && selectedIndex < booksDatabase.length) {
                const globalBook = booksDatabase[selectedIndex];
                const displayName = globalBook.category ? `${globalBook.name} (${globalBook.category})` : globalBook.name;
                await sock.sendMessage(remoteJid, { text: `✅ তালিকা থেকে *${selectedIndex + 1}* নম্বর বইটি (${displayName}) আপলোড হচ্ছে...` });
                await sock.sendMessage(remoteJid, { document: { url: globalBook.link }, mimetype: 'application/pdf', fileName: `${globalBook.name}.pdf` });
                await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                return;
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ সঠিক নম্বর দিন বা 'list' লিখুন।" });
                await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } });
                return;
            }
        }

        // সার্চ ও AI
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
            let bookList = `🔍 *সম্ভাব্য ব‌ই পাওয়া গেছে:* (ব‌ইয়ের নাম্বর লিখে রিপ্লাই দিন)\n\n`;
            const limit = Math.min(matchingBooks.length, 10);
            for(let i = 0; i < limit; i++) {
                const book = matchingBooks[i];
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                bookList += `*${i + 1}.* ${displayName}\n`;
            }
            await sock.sendMessage(remoteJid, { text: bookList });
            await sock.sendMessage(remoteJid, { react: { text: "📚", key: msg.key } });
        } else {
            // গ্রিটিংস ও মেনু
            const greetings = ["হ্যালো", "hi", "হাই", "hello", "salam", "আসসালামু আলাইকুম", "মেনু", "menu"];
           
            // ক) ফুল লিস্ট (বাংলা ফিক্সড ভার্সন)
            if (msgLower.includes("তালিকা") || msgLower.includes("list")) {
                let listText = "📚 *সকল বইয়ের তালিকা*\n\n";

                // যদি ৫০ টার বেশি বই থাকে, তবে ফাইল দেবে
                if (booksDatabase.length > 50) {
                    // লিস্ট তৈরি করা
                    booksDatabase.forEach((book, index) => listText += `${index + 1}. ${book.name} ${book.category ? '('+book.category+')' : ''}\n`);
                    
                    // 🔥 ফিক্স: '\uFEFF' যুক্ত করা হলো (যাতে বাংলা সাপোর্ট করে)
                    const buffer = Buffer.from('\uFEFF' + listText, 'utf-8');

                    await sock.sendMessage(remoteJid, { 
                        document: buffer, 
                        mimetype: 'text/plain; charset=utf-8', // 🔥 charset বলে দেওয়া হলো
                        fileName: 'Book_List.txt', 
                        caption: '📂 সব বইয়ের তালিকা।' 
                    });
                } else {
                    // ৫০ টার কম হলে সরাসরি মেসেজে দেখাবে
                    booksDatabase.forEach((book, index) => {
                        const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                        listText += `*${index + 1}.* ${displayName}\n`;
                    });
                    await sock.sendMessage(remoteJid, { text: listText });
                }
                await sock.sendMessage(remoteJid, { react: { text: "📜", key: msg.key } });
                return;
            }
            
                const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n\n` +
                                 `🤖 *মাকতাবা বট*\n` +
                                 `🔍 *খুঁজতে:* বইয়ের নাম লিখুন।\n` +
                                 `📂 *সব বই:* 'list' লিখুন।\n` +
                                 `🆕 *নতুন:* 'নতুন বই' লিখুন।\n` +
                                 `📝 *অনুরোধ:* 'request [বই]' লিখুন।\n` +
                                 `⁉️ *সাপোর্ট:* 'admin' লিখুন।`;
                await sock.sendMessage(remoteJid, { text: menuText });
                await sock.sendMessage(remoteJid, { react: { text: "👋", key: msg.key } });
                return;
            }

            // AI
            await sock.sendPresenceUpdate('composing', remoteJid);
            const aiResponse = await getGeminiReply(incomingText, remoteJid);
            await sock.sendMessage(remoteJid, { text: aiResponse });
            await sock.sendMessage(remoteJid, { react: { text: "🤖", key: msg.key } });
        }
    });
}

loadBooksFromSheet();
setInterval(loadBooksFromSheet, 30 * 60 * 1000); 
app.get('/', (req, res) => res.send('Bot Running with QR...'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));
connectToWhatsApp();
