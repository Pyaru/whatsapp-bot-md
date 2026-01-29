const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const Fuse = require('fuse.js'); 
const app = express();

const phoneNumber = "8801865760508"; 
const adminNumber = "96897657655@s.whatsapp.net"; 

const supportModeUsers = new Set();
const userSearchSessions = new Map();

// বইয়ের ডাটাবেস
const booksPart1 = require('./books.json');
const booksDatabase = [...booksPart1]; 

const { extractBookKeyword, getGeminiReply } = require('./ai'); 

// ==========================================
// 🛠️ কনফিগারেশন
// ==========================================

const fuseOptions = {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true, 
    minMatchCharLength: 3 
};
const fuse = new Fuse(booksDatabase, fuseOptions);

const toEnglishDigits = (str) => {
    return str.replace(/[০-৯]/g, d => "0123456789"["০১২৩৪৫৬৭৮৯".indexOf(d)]);
};

const cleanUserQuery = (text) => {
    let cleaned = text.replace(/বইটা|বই|দেন|দিন|আছে|কি|চাই|রিসালা|কিতাব|পিডিএফ|pdf|book|download|link|টা/gi, "");
    cleaned = cleaned.replace(/নামাজ/g, "নামায");
    cleaned = cleaned.replace(/ফয়জান/g, "ফয়যান"); 
    cleaned = cleaned.replace(/রমজান/g, "রমযান");
    return cleaned.trim();
};

// ==========================================
// 🚀 মেইন কানেকশন ফাংশন
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

        // ১. সাপোর্ট মোড ও বট স্টার্ট
        if (msgLower === 'admin' || msgLower === 'help' || msgLower === 'এডমিন') {
            supportModeUsers.add(remoteJid);
            userSearchSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "🛑 *সাপোর্ট মোড অন!* এডমিন শীঘ্রই রিপ্লাই দেবেন। পুনরায় সাপোর্ট মোড বন্ধ করে বট চালু করার জন্য bot অথবা start লিখুন" });
            return;
        }
        if (msgLower === 'bot' || msgLower === 'start') {
            supportModeUsers.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "✅ *বট চালু হয়েছে!*" });
            return;
        }
        if (supportModeUsers.has(remoteJid)) return;

        // ২. বইয়ের তালিকা / List ফিচার (সবার আগে চেক করবে)
        const listKeywords = ["list", "book list", "books", "লিস্ট", "তালিকা", "সব বই"];
        if (listKeywords.some(word => msgLower === word || msgLower.includes("লিস্ট"))) {
            
            let listText = "📚 *ইসলামিক লাইব্রেরি - সকল বইয়ের তালিকা*\n\n";
            booksDatabase.forEach((book, index) => {
                listText += `${index + 1}. ${book.name}\n`;
            });
            listText += "\n💡 যেকোনো বই পেতে সেই বইয়ের নাম লিখে মেসেজ দিন।";

            const buffer = Buffer.from(listText, 'utf-8');

            await sock.sendMessage(remoteJid, { text: "📂 বইয়ের তালিকা তৈরি হচ্ছে..." });
            await sock.sendMessage(remoteJid, {
                document: buffer,
                mimetype: 'text/plain',
                fileName: 'All_Books_List.txt',
                caption: '✅ এই ফাইলে আমাদের সব বইয়ের নাম দেওয়া আছে।'
            });
            return; // 🛑 এখানে return করা জরুরি
        }

        // ৩. মেনু / গ্রিটিংস
        const greetings = ["hi", "hello", "salam", "আসসালামু", "সালাম", "হাই", "হ্যালো", "menu", "মেনু"];
        if (greetings.includes(msgLower) || (greetings.some(w => msgLower.includes(w)) && incomingText.length < 10)) {
            const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n\n` +
                             `🔍 *বই খুঁজতে:* নাম লিখুন।\n` +
                             `📂 *সব বই:* 'list' বা 'তালিকা' লিখুন।\n` +
                             `⁉️ *সাহায্য:* 'help' বা 'এডমিন' লিখুন।\n` +
                             `📝 *বই রিকোয়েস্ট:* 'চাই [বইয়ের নাম]' লিখুন।`;
            await sock.sendMessage(remoteJid, { text: menuText });
            return;
        }

        // ৪. রিকোয়েস্ট
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই") || msgLower.startsWith("রিকোয়েস্ট")) {
            const requestedBook = incomingText.replace(/request|চাই|রিকোয়েস্ট/i, "").trim();
            if (adminNumber.includes("968")) {
                await sock.sendMessage(adminNumber, { text: `🔔 *Request:* ${requestedBook}\nFrom: ${remoteJid.split('@')[0]}` });
            }
            await sock.sendMessage(remoteJid, { text: "✅ রিকোয়েস্ট পাঠানো হয়েছে।" });
            return;
        }

        // ৫. সিলেকশন (Multi-Selection Fixed)
        const convertedText = toEnglishDigits(incomingText);
        // চেক করছি এটা নম্বর কি না এবং আগের সেশন আছে কি না
        if (userSearchSessions.has(remoteJid) && !isNaN(convertedText)) {
            const selectedIndex = parseInt(convertedText) - 1;
            const pendingBooks = userSearchSessions.get(remoteJid);

            if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                const selectedBook = pendingBooks[selectedIndex];
                
                await sock.sendMessage(remoteJid, { 
                    text: `✅ *${selectedBook.name}* আপলোড হচ্ছে...\n(অন্য বই নিতে চাইলে তার নম্বর লিখুন)` 
                });
                
                await sock.sendMessage(remoteJid, {
                    document: { url: selectedBook.link },
                    mimetype: 'application/pdf',
                    fileName: `${selectedBook.name}.pdf`
                });
                
                // 🛑 এখানে return দেওয়া হলো যাতে কোড নিচে না যায়
                // এবং session delete করা হলো না, যাতে আবার নম্বর দিয়ে বই নেওয়া যায়
                return; 
            } else {
                await sock.sendMessage(remoteJid, { text: "❌ তালিকায় এই নম্বরটি নেই।" });
                return;
            }
        }

        // ==========================================
        // 🔥 ৬. সার্চ লজিক
        // ==========================================
        
        let searchQuery = cleanUserQuery(incomingText);
        if (!searchQuery) searchQuery = incomingText;

        // খুব ছোট হলে AI
        if (searchQuery.length < 2) {
             const aiResponse = await getGeminiReply(incomingText);
             await sock.sendMessage(remoteJid, { text: aiResponse });
             return;
        }

        // সার্চ
        let results = fuse.search(searchQuery);
        let matchingBooks = results.map(result => result.item);

        // ২য় বার চেষ্টা
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

        // রেজাল্ট দেখানো
        if (matchingBooks.length > 0) {
            userSearchSessions.set(remoteJid, matchingBooks);
            
            let bookList = `🔍 *সম্ভাব্য বই পাওয়া গেছে:* \n(নিচের তালিকা থেকে নম্বর লিখুন)\n\n`;
            const limit = Math.min(matchingBooks.length, 10); // ১০টা পর্যন্ত দেখাবে
            
            for(let i = 0; i < limit; i++) {
                bookList += `*${i + 1}.* ${matchingBooks[i].name}\n`;
            }
            if(matchingBooks.length === 1) {
                bookList += `\n💡 *1* লিখে রিপ্লাই দিন।`;
            }
            await sock.sendMessage(remoteJid, { text: bookList });

        } else {
            // বই না পেলে AI উত্তর দেবে
            await sock.sendPresenceUpdate('composing', remoteJid);
            const aiResponse = await getGeminiReply(incomingText);
            await sock.sendMessage(remoteJid, { text: aiResponse });
        }
    });
}

app.get('/', (req, res) => res.send('Bot is Running'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));

connectToWhatsApp();