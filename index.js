const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const fetch = require('node-fetch'); // 👈 এটি অবশ্যই থাকতে হবে
const app = express();

const phoneNumber = "8801865760508"; 
const adminNumber = "96897657655@s.whatsapp.net"; 

// ==========================================
// 📊 গুগল শিট কনফিগারেশন (বইয়ের সোর্স)
// ==========================================

// 🔴 নিচে আপনার 'Publish to web' থেকে পাওয়া CSV লিংকটি বসান
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv"; 

let booksDatabase = []; // এটি এখন শিট থেকে লোড হবে

// গুগল শিট থেকে বই লোড করার ফাংশন
async function loadBooksFromSheet() {
    try {
        console.log("📥 গুগল শিট থেকে বইয়ের তালিকা আপডেট হচ্ছে...");
        const response = await fetch(SHEET_URL);
        const text = await response.text();
        
        const rows = text.split('\n'); 
        const newBooks = [];

        rows.forEach((row) => {
            // কমা (,) দিয়ে নাম ও লিংক আলাদা করা হয়
            // গুগল শিটে কলাম A = নাম, কলাম B = লিংক রাখবেন
            const parts = row.split(','); 
            
            if (parts.length >= 2) {
                // নামের ভেতর থেকে অতিরিক্ত ক্যারেক্টার বা স্পেস বাদ দেওয়া
                const name = parts[0].trim().replace(/"/g, ''); 
                const link = parts[1].trim();
                
                // শুধুমাত্র ভ্যালিড লিংকগুলো নেবে
                if (link.startsWith('http')) {
                    newBooks.push({ name, link });
                }
            }
        });

        booksDatabase = newBooks;
        
        // সার্চ ইঞ্জিন আপডেট করা
        if (fuse) {
            fuse.setCollection(booksDatabase);
        }
        
        console.log(`✅ ${booksDatabase.length} টি বই সফলভাবে লোড হয়েছে!`);
        
    } catch (error) {
        console.error("❌ বই লোড করতে সমস্যা হয়েছে:", error);
    }
}

// ==========================================
// 🛠️ মেইন কনফিগারেশন
// ==========================================

const supportModeUsers = new Set();
const userSearchSessions = new Map();
const { extractBookKeyword, getGeminiReply } = require('./ai'); 

const fuseOptions = {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 3
};
// শুরুতে খালি ডাটাবেস দিয়ে Fuse চালু হবে, পরে শিট থেকে ডাটা আসবে
let fuse = new Fuse([], fuseOptions);

const toEnglishDigits = (str) => {
    return str.replace(/[০-৯]/g, d => "0123456789"["০১২৩৪৫৬৭৮৯".indexOf(d)]);
};

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

        // ১. এডমিন আপডেট কমান্ড (নতুন বই যুক্ত করলে এটি ব্যবহার করবেন)
        if ((msgLower === 'update' || msgLower === 'refresh') && remoteJid.includes(adminNumber.split('@')[0])) {
            await sock.sendMessage(remoteJid, { text: "🔄 গুগল শিট থেকে বই আপডেট হচ্ছে..." });
            await loadBooksFromSheet();
            await sock.sendMessage(remoteJid, { text: `✅ আপডেট সম্পন্ন! মোট বই: ${booksDatabase.length} টি।` });
            return;
        }

        // ২. সাপোর্ট মোড ও সাধারণ কমান্ড
        if (msgLower === 'admin') {
            supportModeUsers.add(remoteJid);
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "🛑 সাপোর্ট মোড অন। এডমিন শীঘ্রই রিপ্লাই দেবেন। সাপোর্ট মোড বন্ধ করে বট চালু করার জন্য bot অথবা start লিখুন" });
            return;
        }
        if (msgLower === 'bot' || msgLower === 'start') {
            supportModeUsers.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ বট চালু হয়েছে!" });
            return;
        }
        if (supportModeUsers.has(remoteJid)) return;

        // ৩. গ্রিটিংস বা মেনু
        const greetings = ["hi", "hello", "salam", "আসসালামু আলাইকুম", "সালাম", "Assamulaikum", "হাই", "মেনু", "menu"];
        if (greetings.some(w => msgLower.startsWith(w)) && incomingText.length < 15) {
            const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n\n` +
                             `🔍 *বই খুঁজতে:* নাম লিখুন।\n` +
                             `📂 *সব বই:* 'list' বা 'তালিকা' লিখুন।\n` +
                             `⁉️ *সাহায্য:* 'help' বা 'এডমিন' লিখুন।\n` +
                             `📝 *বই রিকোয়েস্ট:* 'চাই [বইয়ের নাম]' লিখুন।`;
            await sock.sendMessage(remoteJid, { text: menuText });
            return;
        }

        // ৪. রিকোয়েস্ট হ্যান্ডলিং
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই")) {
            const requestedBook = incomingText.replace(/request|চাই|রিকোয়েস্ট/i, "").trim();
            if (adminNumber.includes("968")) {
                await sock.sendMessage(adminNumber, { text: `🔔 Request: ${requestedBook} from ${remoteJid}` });
            }
            await sock.sendMessage(remoteJid, { text: "✅ এডমিনকে রিকোয়েস্ট পাঠানো হয়েছে।" });
            return;
        }

        // ৫. ফুল লিস্ট (Full List)
        const listKeywords = ["list", "লিস্ট", "তালিকা", "সব বই", "বইয়ের তালিকা"];
        if (listKeywords.includes(msgLower)) {
            let listText = "📚 *ইসলামিক লাইব্রেরি - সকল বইয়ের তালিকা*\n\n";
            booksDatabase.forEach((book, index) => {
                listText += `${index + 1}. ${book.name}\n`;
            });
            listText += "\n💡 যেকোনো বই পেতে সেই বইয়ের নাম লিখে মেসেজ দিন।";

            const buffer = Buffer.from(listText, 'utf-8');

            await sock.sendMessage(remoteJid, { text: "📂 বইয়ের তালিকা পাঠানো হচ্ছে..." });
            await sock.sendMessage(remoteJid, {
                document: buffer,
                mimetype: 'text/plain',
                fileName: 'Book_List.txt',
                caption: '✅ সব বইয়ের তালিকা এখানে আছে। পছন্দমতো নাম্বর লিখে পাঠান।'
            });
            return;
        }

        // ৬. সিলেকশন হ্যান্ডলিং (সার্চ + মেইন লিস্ট)
        const convertedDigits = toEnglishDigits(incomingText);
        const isOnlyNumber = /^[0-9]+$/.test(convertedDigits);

        if (isOnlyNumber) {
            const selectedIndex = parseInt(convertedDigits) - 1;

            if (userSearchSessions.has(remoteJid)) {
                const pendingBooks = userSearchSessions.get(remoteJid);
                if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                    const selectedBook = pendingBooks[selectedIndex];
                    await sock.sendMessage(remoteJid, { text: `✅ *${selectedBook.name}* আপলোড হচ্ছে...` });
                    await sock.sendMessage(remoteJid, {
                        document: { url: selectedBook.link },
                        mimetype: 'application/pdf',
                        fileName: `${selectedBook.name}.pdf`
                    });
                    return; 
                }
            }

            if (selectedIndex >= 0 && selectedIndex < booksDatabase.length) {
                const globalBook = booksDatabase[selectedIndex];
                await sock.sendMessage(remoteJid, { 
                    text: `✅ তালিকা থেকে *${selectedIndex + 1}* নম্বর বইটি (${globalBook.name}) আপলোড হচ্ছে...` 
                });
                await sock.sendMessage(remoteJid, {
                    document: { url: globalBook.link },
                    mimetype: 'application/pdf',
                    fileName: `${globalBook.name}.pdf`
                });
                return;
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ এই নম্বরের কোনো বই পাওয়া যায়নি।" });
                return;
            }
        }

        // ৭. স্মার্ট সার্চ এবং AI
        let searchQuery = cleanUserQuery(incomingText);
        if (!searchQuery) searchQuery = incomingText;

        if (searchQuery.length < 2) {
             const aiResponse = await getGeminiReply(incomingText);
             await sock.sendMessage(remoteJid, { text: aiResponse });
             return;
        }

        let results = fuse.search(searchQuery);
        let matchingBooks = results.map(result => result.item);

        if (matchingBooks.length === 0) {
            let rawResults = fuse.search(incomingText);
            let rawMatches = rawResults.map(result => result.item);
            
            if (rawMatches.length > 0) {
                matchingBooks = rawMatches;
            } else {
                const extractedKeyword = await extractBookKeyword(incomingText);
                let keywordCleaned = cleanUserQuery(extractedKeyword);
                
                if (keywordCleaned.length > 2 && keywordCleaned !== searchQuery) {
                    let keywordResults = fuse.search(keywordCleaned);
                    matchingBooks = keywordResults.map(result => result.item);
                }
            }
        }

        if (matchingBooks.length > 0) {
            userSearchSessions.set(remoteJid, matchingBooks);
            
            let bookList = `🔍 *সম্ভাব্য বই:* (নম্বর লিখে রিপ্লাই দিন)\n\n`;
            const limit = Math.min(matchingBooks.length, 10); 
            
            for(let i = 0; i < limit; i++) {
                bookList += `*${i + 1}.* ${matchingBooks[i].name}\n`;
            }
            await sock.sendMessage(remoteJid, { text: bookList });

        } else {
            await sock.sendPresenceUpdate('composing', remoteJid);
            const aiResponse = await getGeminiReply(incomingText);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

// অ্যাপ চালুর সাথে সাথে এবং প্রতি ৩০ মিনিটে বই লোড হবে
loadBooksFromSheet();
setInterval(loadBooksFromSheet, 30 * 60 * 1000);

app.get('/', (req, res) => res.send('Bot is Running with Google Sheets'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));

connectToWhatsApp();