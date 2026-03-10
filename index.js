require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const fetch = require('node-fetch'); 
const fs = require('fs'); 
const app = express();

// 🔥 ফোর্স ডিলিট কোড (একবার চালানোর জন্য)
const sessionFolder = 'auth_info_baileys';
if (fs.existsSync(sessionFolder)) {
    console.log("⚠️ পুরনো সেশন ডিলিট করা হচ্ছে...");
    fs.rmSync(sessionFolder, { recursive: true, force: true });
    console.log("✅ সেশন ডিলিট সম্পন্ন! নতুন করে কানেক্ট করুন।");
}

const phoneNumber = "8801865760508"; // আপনার বটের নম্বর (পেয়ারিং কোডের জন্য)
const adminLID = "228088717828220";   // আপনার LID আইডি
const adminPhone = "96897657655";     // আপনার পার্সোনাল নম্বর

// ==========================================
// 📊 ডাটাবেস কনফিগারেশন
// ==========================================
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv"; 
const PDF_LIST_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=456120804&single=true&output=pdf"; 

let booksDatabase = []; 
const USER_DB_FILE = 'users.json'; 
let allUsers = new Set(); 

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
                const topics = parts[4] ? parts[4].trim().replace(/"/g, '') : ""; 
                
                if (link.startsWith('http')) {
                    newBooks.push({ name, link, category, audio, topics });
                }
            }
        });
        booksDatabase = newBooks;
        if (fuse) fuse.setCollection(booksDatabase);
        console.log(`✅ ${booksDatabase.length} টি বই লোড হয়েছে!`);
    } catch (error) { console.error("❌ বই লোড এরর:", error); }
}

const supportModeUsers = new Set();
const userSearchSessions = new Map();
const sessionTimers = new Map(); 
const SESSION_TIMEOUT = 30 * 60 * 1000; 
const rateLimitMap = new Map(); 

const { extractBookKeyword, getGeminiReply } = require('./ai'); 

const fuseOptions = {
    keys: ['name', 'topics'],
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
// 🚀 কানেকশন (Magic QR Link Version)
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // টার্মিনালে ভাঙা QR দেখাবে না
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS('Desktop'), // ম্যাক ওএস সবচেয়ে সেফ
        syncFullHistory: false, 
        generateHighQualityLinkPreview: false,
    });

    // ❌ Pairing Code এর অংশটুকু (setTimeout...) পুরোপুরি মুছে ফেলুন!

    const safeReply = async (jid, textObj) => {
        await sock.sendPresenceUpdate('composing', jid);
        const delay = Math.floor(Math.random() * (4000 - 2000 + 1)) + 2000;
        await new Promise(resolve => setTimeout(resolve, delay));
        await sock.sendMessage(jid, textObj);
        await sock.sendPresenceUpdate('paused', jid);
    };

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ✅ ম্যাজিক QR লিংক তৈরি
        if (qr) {
            console.log("\n=============================================");
            console.log("🔗 নিচের লিংকে ক্লিক করে QR কোডটি বের করুন এবং অন্য ফোন দিয়ে স্ক্যান করুন:");
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
            console.log("=============================================\n");
        }

        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            console.log(`⚠️ কানেকশন বন্ধ! কারণ: ${reason}`);

            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 ৫ সেকেন্ড পর পুনরায় চেষ্টা করা হচ্ছে...");
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log("❌ সেশন নষ্ট হয়ে গেছে। 'rm -rf auth_info_baileys' দিয়ে ডিলিট করে আবার রান করুন।");
            }
        } else if (connection === 'open') {
            console.log('✅ আলহামদুলিল্লাহ! বট সফলভাবে কানেক্টেড এবং রানিং।');
        }
    });
    
    // ==========================================
    // 📩 মেসেজ রিসিভ করার লজিক
    // ==========================================
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const incomingText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const msgLower = incomingText.toLowerCase();

        if (!incomingText) return; 

        saveUser(remoteJid);
        
        // Anti-Spam
        const now = Date.now();
        const lastMsgTime = rateLimitMap.get(remoteJid) || 0;
        if (now - lastMsgTime < 3000) { 
            return; // বটের সার্ভার সেভ করার জন্য চুপ থাকাই ভালো
        }
        rateLimitMap.set(remoteJid, now);

        if (incomingText.length > 1) await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });

        // এডমিন চেক (LID)
        if (msgLower === 'id' || msgLower === 'check') {
            await safeReply(remoteJid, { text: `🕵️ ID: ${remoteJid}` });
            return;
        }

        // আপডেট কমান্ড
        if ((msgLower === 'update' || msgLower === 'refresh') && remoteJid.includes(adminLID)) {
            await safeReply(remoteJid, { text: "🔄 আপডেট হচ্ছে..." });
            await loadBooksFromSheet();
            await safeReply(remoteJid, { text: `✅ আপডেট সম্পন্ন! বই: ${booksDatabase.length}` });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // =============================================
        // 🛡️ আল্ট্রা সেফ ব্রডকাস্ট (Anti-Ban System)
        // =============================================
        if (msgLower.startsWith('broadcast') && remoteJid.includes(adminLID)) {
            const messageToSend = incomingText.replace(/broadcast/i, '').trim();
            if (!messageToSend) {
                await safeReply(remoteJid, { text: "❌ মেসেজ লিখুন। উদাহরণ: broadcast নতুন বই এসেছে!" });
                return;
            }

            const BATCH_SIZE = 40; 
            const BATCH_DELAY = 15 * 60 * 1000; 
            const DAILY_LIMIT = 200; 
            
            const totalUsers = Array.from(allUsers);
            const targetUsers = totalUsers.filter(u => !u.includes('@lid') && !u.includes('g.us')); 
            
            const todayCount = targetUsers.slice(0, DAILY_LIMIT); 
            const remaining = targetUsers.length - DAILY_LIMIT;

            await sock.sendMessage(remoteJid, { 
                text: `🛡️ *সেফ ব্রডকাস্ট চালু হয়েছে!*\n\n👥 মোট টার্গেট: ${targetUsers.length} জন\n📅 আজ পাঠানো হবে: ${todayCount.length} জন\n⏳ বাকি থাকবে: ${remaining > 0 ? remaining : 0} জন (আগামীকাল যাবে)\n\n⚙️ স্ট্র্যাটেজি:\n- প্রতি মেসেজে ১০-৩০ সেকেন্ড র‍্যান্ডম গ্যাপ\n- প্রতি ৪০ জন পর ১৫ মিনিট বিরতি\n\n(ব্যাকগ্রাউন্ডে কাজ চলছে, আপনি নিশ্চিন্ত থাকুন...)` 
            });

            (async () => {
                let successCount = 0;
                let failCount = 0;
                
                for (let i = 0; i < todayCount.length; i++) {
                    const userJid = todayCount[i];
                    try {
                        const randomDelay = Math.floor(Math.random() * (30000 - 10000 + 1)) + 10000;
                        await new Promise(r => setTimeout(r, randomDelay));
                        
                        await sock.sendMessage(userJid, { text: `📢 *নোটিফিকেশন:*\n\n${messageToSend}` });
                        successCount++;

                        if ((i + 1) % BATCH_SIZE === 0) {
                            console.log(`⏸️ ${i + 1} জন সম্পন্ন। ১৫ মিনিট বিরতি চলছে...`);
                            await new Promise(r => setTimeout(r, BATCH_DELAY));
                        }
                    } catch (e) {
                        failCount++;
                        console.log(`Failed: ${userJid}`);
                    }
                }

                await sock.sendMessage(remoteJid, { 
                    text: `✅ *আজকের ব্রডকাস্ট সম্পন্ন!*\n\n🟢 সফল: ${successCount} জন\n🔴 ব্যর্থ: ${failCount} জন` 
                });
            })(); 
            return;
        }

        // =============================================
        // 📊 এডমিন স্ট্যাটস ড্যাশবোর্ড
        // =============================================
        if ((msgLower === 'stats' || msgLower === 'info') && remoteJid.includes(adminLID)) {
            const totalUsers = allUsers.size;
            const totalBooks = booksDatabase.length;
            const totalAudio = booksDatabase.filter(book => book.audio && book.audio.length > 5).length;
            const uptime = process.uptime();
            const uptimeHours = Math.floor(uptime / 3600);
            const uptimeMinutes = Math.floor((uptime % 3600) / 60);
            const memoryUsage = process.memoryUsage();
            const ramUsed = Math.round(memoryUsage.rss / 1024 / 1024);

            const reportText = `📊 *বট অ্যানালিটিক্স রিপোর্ট*\n\n` +
                               `👥 *মোট ইউজার:* ${totalUsers} জন\n` +
                               `📚 *মোট বই:* ${totalBooks} টি\n` +
                               `🎧 *মোট অডিও:* ${totalAudio} টি\n` +
                               `⏳ *সার্ভার আপটাইম:* ${uptimeHours} ঘণ্টা ${uptimeMinutes} মিনিট\n` +
                               `💾 *RAM ব্যবহার:* ${ramUsed} MB\n` +
                               `📅 *তারিখ:* ${new Date().toLocaleDateString('bn-BD')}`;

            await safeReply(remoteJid, { text: reportText });
            await sock.sendMessage(remoteJid, { react: { text: "📊", key: msg.key } });
            return;
        }

        if (['admin', 'এডমিন', 'help'].includes(msgLower)) {
            supportModeUsers.add(remoteJid);
            userSearchSessions.delete(remoteJid);
            await safeReply(remoteJid, { text: "🛑 সাপোর্ট মোড চালু হয়েছে, এডমিন শিঘ্রই আপনার সাথে যোগাযোগ করবেন, পুনরায় বট চালু করার জন্য bot, বা start লিখুন।" });
            return;
        }
        if (['bot', 'বট', 'start'].includes(msgLower)) {
            supportModeUsers.delete(remoteJid);
            await safeReply(remoteJid, { text: "✅ বট চালু হয়েছে!" });
        }
        if (supportModeUsers.has(remoteJid)) return;

        if (["stop", "বাদ", "clear"].includes(msgLower)) {
            userSearchSessions.delete(remoteJid);
            userSearchSessions.delete(remoteJid + "_audio"); 
            await safeReply(remoteJid, { text: "✅ আগের সার্চ লিস্ট ক্লিয়ার করা হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        if (msgLower.startsWith("request") || msgLower.startsWith("চাই")) {
            await sock.sendMessage(adminPhone + "@s.whatsapp.net", { text: `🔔 Request: ${incomingText} \nFrom: ${remoteJid}` });
            await safeReply(remoteJid, { text: "✅ এডমিনকে রিকোয়েস্ট পাঠানো হয়েছে।" });
            await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            return;
        }

        // ℹ️ স্মার্ট ইনফো
        const infoKeywords = ["about", "বট সম্পর্কে", "বট তথ্য", "বট"];
        if (infoKeywords.some(key => msgLower === key)) {
            const totalUsers = allUsers.size;
            const totalBooks = booksDatabase.length;
            const totalAudio = booksDatabase.filter(book => book.audio && book.audio.length > 5).length;

            const aboutMessage = `🤖 *আমি মাকতাবা বট - আপনার বট সহকারী*\n` +
                                 `━━━━━━━━━━━━━━━━━━━━\n` +
                                 `✨ *আমাদের লক্ষ্য:* প্রযুক্তির মাধ্যমে ইলমে দ্বীন সবার কাছে সহজে পৌঁছে দেওয়া।\n\n` +
                                 `📊 *এক নজরে বর্তমান অবস্থা:*\n` +
                                 `👥 পাঠক সংখ্যা: ${totalUsers} জন+\n` +
                                 `📚 সংগৃহীত বই: ${totalBooks} টি\n` +
                                 `🎧 অডিও কালেকশন: ${totalAudio} টি\n\n` +
                                 `💡 *ব্যবহার বিধি:*\n` +
                                 `- 🔍 *বই খুঁজতে:* দাওয়াতে ইসলামীর বইয়ের নাম লিখুন।\n` +
                                 `- 📂 *সব বইয়ের নাম:* 'list' লিখুন।\n` +
                                 `- 📝 *বই অনুরোধ:* 'request [বইয়ের নাম]' লিখুন।\n` +
                                 `- ⁉️ *সাপোর্ট:* 'admin' লিখে মেসেজ দিন。\n` +
                                 `- 🛑 *আগের সার্চ বাতিল:* 'stop' লিখুন।\n` +
                                 `- 🎧 *অডিও শুনতে* বই সিলেক্ট করে 'audio' লিখুন।\n\n` +
                                 `📩 *যোগাযোগ:* কোনো বই না পেলে বা পরামর্শ থাকলে 'request [আপনার কথা]' লিখে জানান।\n\n` +
                                 `_সার্বিক তত্ত্বাবধানে: [মুহাম্মদ পেয়ারু আত্তারী]_`;

            await safeReply(remoteJid, { text: aboutMessage });
            await sock.sendMessage(remoteJid, { react: { text: "ℹ️", key: msg.key } });
            return;
        }

        // নতুন বই ফিচার
        const newBookKeywords = ["new book", "নতুন বই", "আপডেট বই", "নতুন কি এসেছে"];
        if (newBookKeywords.some(key => msgLower.includes(key))) {
            const recentBooks = booksDatabase.slice(-10).reverse();
            userSearchSessions.set(remoteJid, recentBooks);

            let updateMsg = "🎉 *নতুন ১০টি বই:*\n(বই পেতে নম্বর লিখে রিপ্লাই দিন)\n\n";
            recentBooks.forEach((book, index) => {
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                updateMsg += `✨ ${index + 1}. ${displayName}\n`;
            });
            await safeReply(remoteJid, { text: updateMsg });
            await sock.sendMessage(remoteJid, { react: { text: "🆕", key: msg.key } });
            return;
        }

        // বই সিলেকশন
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
                
                await safeReply(remoteJid, { text: `✅ *${displayName}* আপলোড হচ্ছে...` });
                await sock.sendMessage(remoteJid, {
                    document: { url: selectedBook.link },
                    mimetype: 'application/pdf',
                    fileName: `${selectedBook.name}.pdf`
                });

                if (selectedBook.audio && selectedBook.audio.startsWith('http')) {
                    userSearchSessions.set(remoteJid + "_audio", selectedBook.audio);
                    await safeReply(remoteJid, { text: `🎧 *অডিও সংস্করণ উপলব্ধ!* \n\nএই বইটির অডিও শুনতে চাইলে *'audio'* বা *'অডিও'* লিখে রিপ্লাই দিন।` });
                }

                await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                return;
            } else {
                await safeReply(remoteJid, { text: "❌ সঠিক নম্বর দিন অথবা 'list' লিখুন।" });
                await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } });
                return;
            }
        }

        if (msgLower === 'audio' || msgLower === 'অডিও') {
            const audioLink = userSearchSessions.get(remoteJid + "_audio");
            if (audioLink) {
                await safeReply(remoteJid, { text: "🎧 অডিও পাঠানো হচ্ছে..." });
                await sock.sendMessage(remoteJid, { audio: { url: audioLink }, mimetype: 'audio/mp4', ptt: false });
                await sock.sendMessage(remoteJid, { react: { text: "🎶", key: msg.key } });
            } else {
                await safeReply(remoteJid, { text: "⚠️ দুঃখিত! এই বইয়ের কোনো অডিও নেই।" });
            }
            return;
        }

        // সার্চ লজিক
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
            const limit = Math.min(matchingBooks.length, 15);
            for(let i = 0; i < limit; i++) {
                const book = matchingBooks[i];
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                bookList += `*${i + 1}.* ${displayName}\n`;
            }
            await safeReply(remoteJid, { text: bookList });
            await sock.sendMessage(remoteJid, { react: { text: "📚", key: msg.key } });
        } else {
            const greetings = ["hi", "hello", "salam", "আসসালামু আলাইকুম", "সালাম", "হাই", "হ্যালো", "মেনু", "menu", "list", "তালিকা"];
            
            if (greetings.some(w => msgLower.startsWith(w)) && incomingText.length < 25) {
                
                if (msgLower.includes("list") || msgLower.includes("তালিকা")) {
                    if (PDF_LIST_URL && PDF_LIST_URL.length > 10) {
                        await sock.sendMessage(remoteJid, { 
                            document: { url: PDF_LIST_URL },
                            mimetype: 'application/pdf',
                            fileName: 'Book_List.pdf',
                            caption: '📂 সকল বইয়ের তালিকা (PDF)'
                        });
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
                        await safeReply(remoteJid, { text: listText });
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
                await safeReply(remoteJid, { text: menuText });
                await sock.sendMessage(remoteJid, { react: { text: "👋", key: msg.key } });
                return;
            }

            await sock.sendPresenceUpdate('composing', remoteJid);
            const aiResponse = await getGeminiReply(incomingText, remoteJid);
            await safeReply(remoteJid, { text: aiResponse });
            await sock.sendMessage(remoteJid, { react: { text: "🤖", key: msg.key } });
        }
    });
}

loadBooksFromSheet();
setInterval(loadBooksFromSheet, 30 * 60 * 1000); 
app.get('/', (req, res) => res.send('Bot Running with Audio & Fixes...'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));
connectToWhatsApp();
