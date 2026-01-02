// এই পদ্ধতিতে কোনো API KEY লাগে না
async function getGeminiReply(userMessage) {
    try {
            // আমরা AI কে বলে দিচ্ছি সে কীভাবে আচরণ করবে
                    const instruction = "তুমি হলে একটি বইয়ের লাইব্রেরি বট। খুব সুন্দর করে শুদ্ধ বাংলায় ছোট করে উত্তর দাও।";
                            
                                    // লিংকে স্পেস বা বিশেষ ক্যারেক্টার থাকলে সমস্যা হয়, তাই এনকোড করা হচ্ছে
                                            const prompt = encodeURIComponent(`${instruction} User said: "${userMessage}"`);
                                                    
                                                            // ফ্রি এবং ওপেন AI সার্ভার ব্যবহার করছি
                                                                    const url = `https://text.pollinations.ai/${prompt}`;

                                                                            const response = await fetch(url);
                                                                                    
                                                                                            if (!response.ok) {
                                                                                                        throw new Error(`Server status: ${response.status}`);
                                                                                                                }

                                                                                                                        const text = await response.text();
                                                                                                                                return text;

                                                                                                                                    } catch (error) {
                                                                                                                                            console.error("AI Error:", error);
                                                                                                                                                    // যদি একান্তই কাজ না করে, তবে ম্যানুয়াল রিপ্লাই
                                                                                                                                                            if (userMessage.includes("সালাম")) return "ওয়ালাইকুমুস সালাম! আপনাকে কীভাবে সাহায্য করতে পারি?";
                                                                                                                                                                    if (userMessage.includes("কেমন")) return "আলহামদুলিল্লাহ, আমি ভালো আছি। আপনি কোনো বই খুঁজছেন?";
                                                                                                                                                                            return "দুঃখিত, আমার সার্ভারে একটু সমস্যা হচ্ছে। আপনি বইয়ের নাম লিখে সার্চ করুন।";
                                                                                                                                                                                }
                                                                                                                                                                                }

                                                                                                                                                                                module.exports = { getGeminiReply };