require('dotenv').config();
const { Telegraf } = require('telegraf');
const Fuse = require('fuse.js');
const fetch = require('node-fetch');
const fs = require('fs');
const { getGeminiReply, extractBookKeyword } = require('./ai'); // আপনার AI লজিক

// ==========================================
// 📊 কনফিগারেশন
// ==========================================
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const adminID = "আপনার_টেলিগ্রাম_আইডি_এখানে_দিন"; // (পরে কিভাবে পাবেন বলে দিচ্ছি)

const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=1594849656&single=true&output=csv";
const PDF_LIST_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ19XPVA-RJZJMAKYyL6atGl-HrpWMf0kruA_A1qIC6FNksEaJmd7jcrTCfVxGYzw/pub?gid=456120804&single=true&output=pdf"; 

let booksDatabase = [];
const USER_DB_FILE = 'users.json';
let allUsers = new Set();

// ইউজার ডাটাবেস লোড
if (!fs.existsSync(USER_DB_FILE)) fs.writeFileSync(USER_DB_FILE, JSON.stringify([]));
try {
    const data = fs.readFileSync(USER_DB_FILE);
    allUsers = new Set(JSON.parse(data));
} catch (e) {
    fs.writeFileSync(USER_DB_FILE, JSON.stringify([]));
}

function saveUser(userId) {
    if (userId && !allUsers.has(userId)) {
        allUsers.add(userId);
        fs.writeFileSync(USER_DB_FILE, JSON.stringify([...allUsers]));
    }
}

// বই লোড (অডিও কলাম সহ)
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

const userSearchSessions = new Map(); 
const supportModeUsers = new Set();

const fuseOptions = { keys: ['name'], threshold: 0.4, includeScore: true, ignoreLocation: true, minMatchCharLength: 3 };
let fuse = new Fuse([], fuseOptions);
const toEnglishDigits = (str) => str.replace(/[০-৯]/g, d => "0123456789"["০১২৩৪৫৬৭৮৯".indexOf(d)]);

// ==========================================
// 🚀 বটের কমান্ড ও লজিক
// ==========================================

// ১. Start / Menu
bot.start((ctx) => {
    saveUser(ctx.from.id.toString());
    const menuText = `📚 *আসসালামু আলাইকুম!*\nমাকতাবা লাইব্রেরিতে স্বাগতম।\n\n🔍 *বই খুঁজতে:* বইয়ের নাম লিখুন।\n📂 *সব বই:* /list ক্লিক করুন।\n🆕 *নতুন বই:* 'নতুন বই' লিখুন।\n📝 *রিকোয়েস্ট:* 'চাই [বই]' লিখুন।\nℹ️ *বিস্তারিত:* /info ক্লিক করুন।`;
    ctx.replyWithMarkdown(menuText);
});

// ২. List
bot.command('list', async (ctx) => {
    saveUser(ctx.from.id.toString());
    if (PDF_LIST_URL) {
        await ctx.replyWithDocument(PDF_LIST_URL, { caption: '📂 সকল বইয়ের তালিকা (PDF)' });
    } else {
        ctx.reply("❌ পিডিএফ লিংক পাওয়া যায়নি।");
    }
});

// ৩. Info / Stats (পাবলিক)
bot.command('info', (ctx) => {
    const totalUsers = allUsers.size;
    const totalBooks = booksDatabase.length;
    const totalAudio = booksDatabase.filter(book => book.audio && book.audio.length > 5).length;
    const aboutMessage = `🤖 *মাকতাবা বট - আপনার সহকারী*\n\n👥 পাঠক সংখ্যা: ${totalUsers} জন+\n📚 সংগৃহীত বই: ${totalBooks} টি\n🎧 অডিও কালেকশন: ${totalAudio} টি\n\n💡 _যেকোনো বই পেতে নাম লিখে সার্চ করুন।_`;
    ctx.replyWithMarkdown(aboutMessage);
});

// ==========================================
// 📩 মেসেজ রিসিভার (লজিক)
// ==========================================
bot.on('text', async (ctx) => {
    const incomingText = ctx.message.text.trim();
    const msgLower = incomingText.toLowerCase();
    const userId = ctx.from.id.toString();

    saveUser(userId);

    // 🕵️ এডমিন আইডি চেক
    if (msgLower === 'id' || msgLower === 'check') {
        return ctx.reply(`🕵️ *আপনার টেলিগ্রাম ID:* \n${userId}\n\n(এটি কপি করে adminID তে বসান)`);
    }

    // 🔄 আপডেট (Admin Only)
    if ((msgLower === 'update' || msgLower === 'refresh') && userId === adminID) {
        await ctx.reply("🔄 ডাটাবেস আপডেট হচ্ছে...");
        await loadBooksFromSheet();
        return ctx.reply(`✅ আপডেট সম্পন্ন! মোট বই: ${booksDatabase.length} টি।`);
    }

    // 📊 স্ট্যাটাস (Admin Only)
    if (msgLower === 'stats' && userId === adminID) {
        const uptimeHours = Math.floor(process.uptime() / 3600);
        const report = `📊 *বট অ্যানালিটিক্স*\n\n👥 মোট ইউজার: ${allUsers.size} জন\n📚 মোট বই: ${booksDatabase.length} টি\n⏳ আপটাইম: ${uptimeHours} ঘণ্টা\n💾 RAM: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`;
        return ctx.replyWithMarkdown(report);
    }

    // 💾 ব্যাকআপ (Admin Only)
    if (msgLower === 'backup' && userId === adminID) {
        const userList = JSON.stringify(Array.from(allUsers), null, 2);
        fs.writeFileSync('users_backup.json', userList);
        return ctx.replyWithDocument({ source: 'users_backup.json' }, { caption: `✅ ইউজার ব্যাকআপ সম্পন্ন।` });
    }

    // 📢 ব্রডকাস্ট (Admin Only - No Ban Risk!)
    if (msgLower.startsWith('broadcast') && userId === adminID) {
        const messageToSend = incomingText.replace(/broadcast/i, '').trim();
        if (!messageToSend) return ctx.reply("❌ মেসেজ লিখুন।");
        
        ctx.reply(`📢 ${allUsers.size} জনকে মেসেজ পাঠানো হচ্ছে...`);
        let success = 0, fail = 0;
        
        for (const user of allUsers) {
            try {
                // টেলিগ্রামে ডিলে (Delay) বা সেফটি লাগে না, তাই দ্রুত যাবে
                await bot.telegram.sendMessage(user, `📢 *নোটিফিকেশন:*\n\n${messageToSend}`, { parse_mode: "Markdown" });
                success++;
            } catch (e) { fail++; }
        }
        return ctx.reply(`✅ *ব্রডকাস্ট সম্পন্ন!*\nসফল: ${success} | ব্যর্থ: ${fail}`);
    }

    // 🛑 সাপোর্ট মোড / ক্লিয়ার
    if (['admin', 'help'].includes(msgLower)) {
        supportModeUsers.add(userId);
        userSearchSessions.delete(userId);
        return ctx.reply("🛑 সাপোর্ট মোড চালু। এডমিন শীঘ্রই যোগাযোগ করবেন। বট চালু করতে 'bot' লিখুন।");
    }
    if (['bot', 'start'].includes(msgLower)) {
        supportModeUsers.delete(userId);
        return ctx.reply("✅ বট চালু হয়েছে!");
    }
    if (supportModeUsers.has(userId)) return;

    if (["stop", "clear", "বাদ"].includes(msgLower)) {
        userSearchSessions.delete(userId);
        userSearchSessions.delete(userId + "_audio");
        return ctx.reply("✅ আগের সার্চ ক্লিয়ার করা হয়েছে।");
    }

    // 🔔 রিকোয়েস্ট
    if (msgLower.startsWith("request") || msgLower.startsWith("চাই")) {
        const requestText = incomingText.replace(/request|চাই/i, "").trim();
        if (requestText) {
            if (adminID) bot.telegram.sendMessage(adminID, `🔔 *রিকোয়েস্ট!*\n\n📝 বিষয়: ${requestText}\n👤 ইউজার ID: ${userId}`);
            return ctx.reply("✅ রিকোয়েস্ট এডমিনের কাছে পাঠানো হয়েছে।");
        }
    }

    // 🆕 নতুন বই
    const newBookKeywords = ["new book", "নতুন বই", "আপডেট বই", "নতুন কি এসেছে"];
    if (newBookKeywords.some(key => msgLower.includes(key))) {
        const recentBooks = booksDatabase.slice(-10).reverse();
        userSearchSessions.set(userId, recentBooks);
        let updateMsg = "🎉 *নতুন ১০টি বই:*\n(বই পেতে নম্বর লিখে রিপ্লাই দিন)\n\n";
        recentBooks.forEach((book, index) => {
            const displayName = book.category ? `${book.name} (${book.category})` : book.name;
            updateMsg += `✨ ${index + 1}. ${displayName}\n`;
        });
        return ctx.replyWithMarkdown(updateMsg);
    }

    // 📥 বই সিলেকশন ও ডাউনলোড
    const convertedDigits = toEnglishDigits(incomingText);
    const isOnlyNumber = /^[0-9]+$/.test(convertedDigits);

    if (isOnlyNumber) {
        const selectedIndex = parseInt(convertedDigits) - 1;
        let selectedBook = null;

        if (userSearchSessions.has(userId)) {
            const pendingBooks = userSearchSessions.get(userId);
            if (selectedIndex >= 0 && selectedIndex < pendingBooks.length) {
                selectedBook = pendingBooks[selectedIndex];
            }
        } else if (selectedIndex >= 0 && selectedIndex < booksDatabase.length) {
            selectedBook = booksDatabase[selectedIndex];
        }

        if (selectedBook) {
            const displayName = selectedBook.category ? `${selectedBook.name} (${selectedBook.category})` : selectedBook.name;
            await ctx.reply(`✅ *${displayName}* পাঠানো হচ্ছে...`);
            
            try {
                // টেলিগ্রামে সরাসরি লিংক থেকে ডকুমেন্ট পাঠানো যায়
                await ctx.replyWithDocument(selectedBook.link);
                
                if (selectedBook.audio && selectedBook.audio.startsWith('http')) {
                    userSearchSessions.set(userId + "_audio", selectedBook.audio);
                    await ctx.reply(`🎧 *অডিও আছে!* শুনতে চাইলে 'audio' বা 'অডিও' লিখুন।`);
                }
            } catch(e) {
                ctx.reply("❌ ফাইলটি পাঠাতে সমস্যা হচ্ছে। লিংকটি চেক করুন।");
            }
            return;
        } else {
            return ctx.reply("❌ সঠিক নম্বর দিন অথবা /list ক্লিক করুন।");
        }
    }

    // 🎧 অডিও
    if (msgLower === 'audio' || msgLower === 'অডিও') {
        const audioLink = userSearchSessions.get(userId + "_audio");
        if (audioLink) {
            await ctx.reply("🎧 অডিও পাঠানো হচ্ছে...");
            return ctx.replyWithAudio(audioLink);
        } else {
            return ctx.reply("⚠️ দুঃখিত! এই বইয়ের কোনো অডিও নেই।");
        }
    }

    // 🔍 সার্চ লজিক
    let results = fuse.search(cleanUserQuery(incomingText));
    let matchingBooks = results.map(result => result.item).slice(0, 15);

    if (matchingBooks.length > 0) {
        userSearchSessions.set(userId, matchingBooks);
        let bookList = `🔍 *পাওয়া গেছে:* (নম্বর দিন)\n\n`;
        matchingBooks.forEach((book, i) => {
            const displayName = book.category ? `${book.name} (${book.category})` : book.name;
            bookList += `*${i + 1}.* ${displayName}\n`;
        });
        return ctx.replyWithMarkdown(bookList);
    } else {
        // 🤖 AI রিপ্লাই (যদি বই না পায়)
        ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        const aiResponse = await getGeminiReply(incomingText);
        return ctx.reply(aiResponse);
    }
});

// ==========================================
// 🚀 সার্ভার চালু
// ==========================================
loadBooksFromSheet();
setInterval(loadBooksFromSheet, 30 * 60 * 1000); 

bot.launch().then(() => {
    console.log('🚀 টেলিগ্রাম বট সফলভাবে চালু হয়েছে!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
