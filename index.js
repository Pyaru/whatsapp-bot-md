require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const { TOKEN, VERIFY_TOKEN, PHONE_NUMBER_ID } = process.env;

// ==========================================
// 🌐 Webhook Verification (মেটা যখন চেক করবে)
// ==========================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook Verified!');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// ==========================================
// 📩 Message Receiving & Replying (বটের আসল কাজ)
// ==========================================
app.post('/webhook', async (req, res) => {
    let body = req.body;

    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            
            let from = body.entry[0].changes[0].value.messages[0].from; // যে মেসেজ দিয়েছে
            let msg_body = body.entry[0].changes[0].value.messages[0].text.body; // মেসেজের টেক্সট

            console.log(`📩 মেসেজ এসেছে: ${msg_body} (From: ${from})`);

            // 🤖 এখানে আপনার বটের রিপ্লাই লজিক থাকবে (পরে আমরা পুরো লজিক বসাব)
            let replyText = `আসসালামু আলাইকুম! আপনি বলেছেন: "${msg_body}"। আমি মাকতাবা বট, বর্তমানে আমি অফিশিয়াল API তে আপগ্রেড হচ্ছি।`;

            // 📤 মেসেজ পাঠানোর কোড (অফিসিয়াল API)
            try {
                await axios({
                    method: 'POST',
                    url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
                    data: {
                        messaging_product: 'whatsapp',
                        to: from,
                        text: { body: replyText }
                    },
                    headers: {
                        'Authorization': `Bearer ${TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
            } catch (error) {
                console.error("❌ মেসেজ পাঠাতে এরর:", error.response ? error.response.data : error.message);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 সার্ভার রানিং পোর্টে ${PORT}`);
});
