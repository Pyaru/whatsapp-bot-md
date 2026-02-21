const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const fetch = require('node-fetch'); 
const fs = require('fs'); 
const qrcode = require('qrcode-terminal'); 
const app = express();

const phoneNumber = "8801865760508"; 
const adminNumber = "228088717828220"; // আপনার LID আইডি এখানে বসাবেন

// ==========================================
// 📊 কনফিগারেশন
// ==========================================
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv"; 

// আপনার Sheet2 এর PDF লিংক (যদি থাকে বসাবেন, না থাকলে খালি রাখুন)
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

// বই লোড (অডিও কলাম সহ - Column D)
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
                // ৪র্থ কলামে অডিও লিংক (যদি থাকে)
                const audio = parts[3] ? parts[3].trim() : ""; 
                
                if (link.startsWith('http')) {
                    newBooks.push({ name, link, category, audio });
                }
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
// 🚀 কানেকশন
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, 
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false, 
    });

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

        // এডমিন চেক (LID)
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

       // =============================================
        // 📢 সুপার সেফ ব্রডকাস্ট (১০ সেকেন্ড ডিলে)
        // =============================================
        if (msgLower.startsWith('broadcast')) {
            // ১. এডমিন চেক
            if (!remoteJid.includes(adminNumber)) {
                return; 
            }

            const messageToSend = incomingText.replace(/broadcast/i, '').trim();
            if (!messageToSend) {
                await sock.sendMessage(remoteJid, { text: "❌ মেসেজ লিখুন। উদাহরণ: broadcast স্লামালিকুম" });
                return;
            }

            // ২. এডমিনকে জানিয়ে দেওয়া
            const totalUsers = allUsers.size;
            const estimatedTime = Math.round((totalUsers * 10) / 60); // ১০ সেকেন্ড করে সময়
            
            await sock.sendMessage(remoteJid, { 
                text: `🚀 *ব্রডকাস্ট শুরু হয়েছে!* (ব্যাকগ্রাউন্ডে)\n\n👥 টার্গেট: ${totalUsers} জন\n⏳ প্রতি মেসেজ গ্যাপ: ১০ সেকেন্ড\n🕒 আনুমানিক সময়: ${estimatedTime} মিনিট\n\n(আপনি এখন নিশ্চিন্তে অন্য কাজ করতে পারেন, শেষ হলে আমি রিপোর্ট দেব।)` 
            });

            // ৩. ব্যাকগ্রাউন্ড প্রসেস (অ্যাসিনক্রোনাস)
            // এটি মেইন থ্রেড ব্লক করবে না
            (async () => {
                let successCount = 0;
                let failCount = 0;
                
                // ইউজারদের অ্যারে বানানো
                const usersArray = Array.from(allUsers);

                for (let i = 0; i < usersArray.length; i++) {
                    const userJid = usersArray[i];

                    // গ্রুপ বা LID বাদ
                    if (userJid.includes('@lid') || userJid.includes('g.us')) continue;

                    try {
                        // ১০ সেকেন্ড গ্যাপ (Super Safe Mode)
                        await new Promise(r => setTimeout(r, 10000)); 
                        
                        await sock.sendMessage(userJid, { text: `📢 *নোটিফিকেশন:*\n\n${messageToSend}` });
                        successCount++;
                        
                        // প্রতি ৫০ জন পর পর কনসোলে লগ দেখাবে (ডিব্যাগিং)
                        if (successCount % 50 === 0) {
                            console.log(`✅ Sent to ${successCount} users...`);
                        }

                    } catch (e) {
                        failCount++;
                        console.log(`Failed: ${userJid}`);
                    }
                }

                // ৪. কাজ শেষ হলে এডমিনকে রিপোর্ট
                await sock.sendMessage(remoteJid, { 
                    text: `✅ *ব্রডকাস্ট মিশন সম্পন্ন!*\n\n🟢 সফল: ${successCount} জন\n🔴 ব্যর্থ: ${failCount} জন\n⏱️ মোট সময় লেগেছে: ${estimatedTime} মিনিট।` 
                });

            })(); // ফাংশন কল শেষ

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
            userSearchSessions.delete(remoteJid + "_audio"); // অডিও সেশন ক্লিয়ার
            await sock.sendMessage(remoteJid, { text: "✅ আগের চার্চ লিস্ট ক্লিয়ার করা হয়েছে।" });
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

        // 🔥 ১. নতুন বই ফিচার (ফিক্সড - এখন নম্বর কাজ করবে)
        const newBookKeywords = ["new book", "নতুন বই", "আপডেট বই", "নতুন কি এসেছে"];
        if (newBookKeywords.some(key => msgLower.includes(key))) {
            const recentBooks = booksDatabase.slice(-10).reverse();
            
            // 💡 ফিক্স: নতুন বইগুলো মেমোরিতে সেভ করা হলো
            userSearchSessions.set(remoteJid, recentBooks);

            let updateMsg = "🎉 *নতুন ১০টি বই:*\n(বই পেতে নম্বর লিখে রিপ্লাই দিন)\n\n";
            recentBooks.forEach((book, index) => {
                const displayName = book.category ? `${book.name} (${book.category})` : book.name;
                updateMsg += `✨ ${index + 1}. ${displayName}\n`;
            });
            await sock.sendMessage(remoteJid, { text: updateMsg });
            await sock.sendMessage(remoteJid, { react: { text: "🆕", key: msg.key } });
            return;
        }

        // 🔥 ২. বই সিলেকশন হ্যান্ডলিং (অডিও সহ)
        const convertedDigits = toEnglishDigits(incomingText);
        const isOnlyNumber = /^[0-9]+$/.test(convertedDigits);

        if (isOnlyNumber) {
            const selectedIndex = parseInt(convertedDigits) - 1;
            let selectedBook = null;

            // সার্চ সেশন চেক (নতুন বই বা সার্চ রেজাল্ট)
            if (userSearchSessions.has(remoteJid)) {
                const pendingBooks = userSearchSessions.get(remoteJid);
                if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                    selectedBook = pendingBooks[selectedIndex];
                }
            }
            // মেইন তালিকা চেক
            else if (selectedIndex >= 0 && selectedIndex < booksDatabase.length) {
                selectedBook = booksDatabase[selectedIndex];
            }

            if (selectedBook) {
                const displayName = selectedBook.category ? `${selectedBook.name} (${selectedBook.category})` : selectedBook.name;
                
                await sock.sendMessage(remoteJid, { text: `✅ *${displayName}* আপলোড হচ্ছে...` });
                await sock.sendMessage(remoteJid, {
                    document: { url: selectedBook.link },
                    mimetype: 'application/pdf',
                    fileName: `${selectedBook.name}.pdf`
                });

                // 🎧 অডিও অফার
                if (selectedBook.audio && selectedBook.audio.startsWith('http')) {
                    userSearchSessions.set(remoteJid + "_audio", selectedBook.audio);
                    await sock.sendMessage(remoteJid, { text: `🎧 *অডিও সংস্করণ উপলব্ধ!* \n\nএই বইটির অডিও শুনতে চাইলে *'audio'* বা *'অডিও'* লিখে রিপ্লাই দিন।` });
                }

                await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
                return;
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ সঠিক নম্বর দিন অথবা 'list' লিখুন।" });
                await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } });
                return;
            }
        }

        // 🔥 ৩. অডিও কমান্ড হ্যান্ডলিং
        if (msgLower === 'audio' || msgLower === 'অডিও') {
            const audioLink = userSearchSessions.get(remoteJid + "_audio");
            if (audioLink) {
                await sock.sendMessage(remoteJid, { text: "🎧 অডিও পাঠানো হচ্ছে..." });
                await sock.sendMessage(remoteJid, { audio: { url: audioLink }, mimetype: 'audio/mp4', ptt: false });
                await sock.sendMessage(remoteJid, { react: { text: "🎶", key: msg.key } });
            } else {
                await sock.sendMessage(remoteJid, { text: "⚠️ দুঃখিত! এই বইয়ের কোনো অডিও নেই।" });
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
            await sock.sendMessage(remoteJid, { text: bookList });
            await sock.sendMessage(remoteJid, { react: { text: "📚", key: msg.key } });
        } else {
            // 🔥 ৪. মেনু ও গ্রিটিংস (লিস্ট/তালিকা এবং সব বাংলা হ্যালো ফিক্সড)
            const greetings = ["hi", "hello", "salam", "আসসালামু আলাইকুম", "সালাম", "হাই", "হ্যালো", "মেনু", "menu", "list", "তালিকা"];
            
            if (greetings.some(w => msgLower.startsWith(w)) && incomingText.length < 25) {
                
                // ক) তালিকা বা লিস্ট
                if (msgLower.includes("list") || msgLower.includes("তালিকা")) {
                    
                    // যদি PDF লিংক থাকে তবে PDF দেবে
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

                    // না থাকলে টেক্সট ফাইল (নরমাল)
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

                // খ) মেইন মেনু
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
app.get('/', (req, res) => res.send('Bot Running with Audio & Fixes...'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));
connectToWhatsApp();
