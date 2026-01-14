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

// AI ফাইল
const { extractBookKeyword } = require('./ai'); 

// ফাজি সার্চ কনফিগারেশন
const fuseOptions = {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true
};
const fuse = new Fuse(booksDatabase, fuseOptions);

// 🛠️ বাংলা সংখ্যা কনভার্টার ফাংশন
const toEnglishDigits = (str) => {
    return str.replace(/[০-৯]/g, d => "0123456789"["০১২৩৪৫৬৭৮৯".indexOf(d)]);
};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
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

        // --- মেনু ---
        const greetings = ["hi", "hello", "salam", "আসসালামু", "সালাম", "menu"];
        if (greetings.some(word => msgLower.includes(word))) {
            const menuText = `📚 *আসসালামু আলাইকুম!* ইসলামিক লাইব্রেরিতে স্বাগতম।\n🔍 বই খুঁজতে নাম লিখুন।\n📝 রিকোয়েস্ট করতে 'চাই [বইয়ের নাম]' লিখুন।`;
            await sock.sendMessage(remoteJid, { text: menuText });
            return;
        }

        // --- রিকোয়েস্ট ---
        if (msgLower.startsWith("request") || msgLower.startsWith("চাই") || msgLower.startsWith("রিকোয়েস্ট")) {
            const requestedBook = incomingText.replace(/request|চাই|রিকোয়েস্ট/i, "").trim();
            if (adminNumber.includes("880")) {
                await sock.sendMessage(adminNumber, { text: `🔔 *Request:* ${requestedBook}\nFrom: ${remoteJid.split('@')[0]}` });
            }
            await sock.sendMessage(remoteJid, { text: "✅ রিকোয়েস্ট পাঠানো হয়েছে।" });
            return;
        }

        // --- সিলেকশন (১, ২, ৩... বা 1, 2, 3...) ---
        // প্রথমে বাংলা সংখ্যাকে ইংরেজিতে কনভার্ট করা হচ্ছে
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
                // ইউজার যদি ভুল সংখ্যা দেয়, তাকে জানানো
                await sock.sendMessage(remoteJid, { text: "❌ তালিকায় এই নম্বরটি নেই। দয়া করে সঠিক নম্বরটি লিখুন।" });
                return;
            }
        }

        // ==========================================
        // 🔥 ফাজি সার্চ লজিক
        // ==========================================
        let results = fuse.search(incomingText);
        let matchingBooks = results.map(result => result.item);

        if (matchingBooks.length === 0) {
            await sock.sendPresenceUpdate('composing', remoteJid);
            const extractedKeyword = await extractBookKeyword(incomingText);
            
            if (extractedKeyword.toLowerCase() !== msgLower) {
                let keywordResults = fuse.search(extractedKeyword);
                matchingBooks = keywordResults.map(result => result.item);
            }
        }

        if (matchingBooks.length > 0) {
            userSearchSessions.set(remoteJid, matchingBooks);
            
            let bookList = `🔍 *সম্ভাব্য বই পাওয়া গেছে:* \n(নিচের তালিকা থেকে নম্বর লিখুন)\n\n`;
            const limit = Math.min(matchingBooks.length, 5); 
            
            for(let i = 0; i < limit; i++) {
                bookList += `*${i + 1}.* ${matchingBooks[i].name}\n`;
            }

            if(matchingBooks.length === 1) {
                bookList += `\n💡 আপনি *1* বা *১* লিখে রিপ্লাই দিলেই পিডিএফ পেয়ে যাবেন।`;
            }

            await sock.sendMessage(remoteJid, { text: bookList });

        } else {
            await sock.sendMessage(remoteJid, { text: "⚠️ দুঃখিত, বইটি পাওয়া যায়নি।\nআপনি চাইলে *request [বইয়ের নাম]* লিখে রিকোয়েস্ট করতে পারেন।" });
        }
    });
}

app.get('/', (req, res) => res.send('Bot is Running'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));

connectToWhatsApp();