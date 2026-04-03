const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const crypto = require("crypto");
const express = require("express");

// ========== ENVIRONMENT ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const OWNER_ID = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID) : 6252869088;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !MONGODB_URI) {
  console.error("❌ Missing BOT_TOKEN or MONGODB_URI");
  process.exit(1);
}

let cachedBotUsername = "";

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000,
});
mongoose.connection.once("open", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", err => console.error("MongoDB error:", err));

// ========== SCHEMAS (FIXED) ==========
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: { type: String, default: "" },
  displayName: { type: String, default: "Anonymous User" },
  profilePic: { type: String, default: "" },
  questions: { type: [String], default: [] },
  token: { type: String, required: true, unique: true },
  location: { type: String, default: "" },
  age: { type: Number, default: null },
  gender: { type: String, default: "" },
  privacy: { showLocation: Boolean, showAge: Boolean, default: {} },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

// FIXED: unlockMethod ka default undefined rakha (null allowed nahi tha)
const messageSchema = new mongoose.Schema({
  receiverId: { type: Number, required: true },
  senderToken: { type: String, required: true },
  content: { type: String, required: true },
  preview: { type: String, required: true },
  status: { type: String, enum: ["pending", "unlocked"], default: "pending" },
  unlockMethod: { type: String, enum: ["share", "stars"], default: undefined },
  reply: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  unlockedAt: { type: Date, default: null }
});
const Message = mongoose.model("Message", messageSchema);

const paymentSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  transactionId: { type: String, required: true, unique: true },
  amountStars: { type: Number, required: true },
  type: { type: String, enum: ["unlock", "premium"], required: true },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
  createdAt: { type: Date, default: Date.now }
});
const Payment = mongoose.model("Payment", paymentSchema);

const rateLimitSchema = new mongoose.Schema({
  senderId: { type: Number, required: true },
  recipientId: { type: Number, required: true },
  date: { type: String, required: true },
  count: { type: Number, default: 0 }
});
rateLimitSchema.index({ senderId: 1, recipientId: 1, date: 1 }, { unique: true });
const RateLimit = mongoose.model("RateLimit", rateLimitSchema);

// ========== HELPERS ==========
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

async function ensureUser(userId, username, displayName = null) {
  let user = await User.findOne({ userId });
  if (user) {
    user.lastActive = new Date();
    if (username && !user.username) user.username = username;
    if (displayName) user.displayName = displayName;
    await user.save();
    return user.token;
  }
  const token = generateToken();
  user = new User({
    userId,
    username: username || "",
    displayName: displayName || (username ? username : `User ${userId}`),
    token,
    createdAt: new Date()
  });
  await user.save();
  return token;
}

async function getUserByToken(token) {
  return User.findOne({ token });
}

// createMessage ab error nahi degi
async function createMessage(receiverId, content, senderToken) {
  const preview = content.split(" ").slice(0, 5).join(" ");
  const message = new Message({
    receiverId,
    senderToken,
    content,
    preview,
    status: "pending"
    // unlockMethod intentionally not set → undefined, validation pass
  });
  await message.save();
  return message;
}

async function checkRateLimit(senderId, recipientId) {
  const today = new Date().toISOString().slice(0, 10);
  const perRecipient = await RateLimit.findOne({ senderId, recipientId, date: today });
  if (perRecipient && perRecipient.count >= 3) return false;
  const totalToday = await RateLimit.aggregate([
    { $match: { senderId, date: today } },
    { $group: { _id: null, total: { $sum: "$count" } } }
  ]);
  const total = totalToday[0]?.total || 0;
  if (total >= 10) return false;
  return true;
}

async function incrementRateLimit(senderId, recipientId) {
  const today = new Date().toISOString().slice(0, 10);
  await RateLimit.updateOne(
    { senderId, recipientId, date: today },
    { $inc: { count: 1 } },
    { upsert: true }
  );
}

async function generateFriendPortrait(userId, userDisplayName) {
  const messages = await Message.find({ receiverId: userId, status: "unlocked" }).limit(50);
  if (messages.length < 5) return null;
  const allText = messages.map(m => m.content.toLowerCase()).join(" ");
  const words = allText.split(/\W+/).filter(w => w.length > 3);
  const stopwords = new Set(["the","this","that","with","from","have","like","just","what","when","how","really","very","about","your","you"]);
  const freq = {};
  for (const w of words) {
    if (stopwords.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  const sorted = Object.entries(freq).sort((a,b) => b[1] - a[1]).slice(0, 5);
  if (sorted.length === 0) return null;
  const topWords = sorted.map(([w]) => w).join(", ");
  return `🧠 *Friend Portrait for ${userDisplayName}*\n\nBased on ${messages.length} anonymous messages, people often describe you as: *${topWords}*.\n\nKeep sharing your link to get more insights! 🌟`;
}

// ========== BOT INSTANCE ==========
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.getMe().then((me) => {
  cachedBotUsername = me.username;
  console.log(`🤖 Bot started as @${cachedBotUsername}`);
});

// ========== EXPRESS SERVER ==========
const app = express();
app.use(express.static('public'));

app.get("/", (req, res) => res.send("✅ Bot is running"));

app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

// ========== COMMANDS ==========
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const param = match[1];

  if (!cachedBotUsername) {
    const me = await bot.getMe();
    cachedBotUsername = me.username;
  }

  if (param && param.startsWith("ref_")) {
    await bot.sendMessage(chatId, `👋 Welcome! Your inbox is ready. Share your link to start receiving anonymous messages.`);
    return;
  }

  if (param && !param.startsWith("ref_")) {
    const user = await getUserByToken(param);
    if (user) {
      const keyboard = {
        reply_markup: {
          inline_keyboard: [[{ text: "✍️ Send anonymous message", callback_data: `send_to_${user.userId}` }]]
        }
      };
      await bot.sendMessage(chatId, `📝 Send an anonymous message to @${user.username || user.displayName}`, keyboard);
      return;
    }
  }

  const token = await ensureUser(userId, username);
  const profileLink = `https://t.me/${cachedBotUsername}?start=${token}`;
  const shareButtons = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📱 WhatsApp", url: `https://wa.me/?text=Check%20out%20my%20anonymous%20inbox%20on%20Telegram%3A%20${encodeURIComponent(profileLink)}` },
          { text: "✈️ Telegram", url: `https://t.me/share/url?url=${encodeURIComponent(profileLink)}&text=Send%20me%20anonymous%20messages%20here!` }
        ],
        [
          { text: "📘 Facebook", url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(profileLink)}` },
          { text: "📷 Instagram", callback_data: `copy_link_${token}` }
        ],
        [
          { text: "🔗 Copy Link", callback_data: `copy_link_${token}` }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId,
    `🎉 *Your anonymous inbox is ready!*\n\nShare your link with friends, followers, or anyone using the buttons below. They can send you anonymous messages. You'll get a blurred preview and can unlock each message for free (by sharing the bot) or with Telegram Stars.\n\n📊 Use /status to see pending messages.\n🎁 Use /random to send an anonymous message to a random user.\n🏆 Use /rank to see leaderboard.\n💡 Use /portrait to generate a shareable friend portrait (after 5+ messages).`,
    { parse_mode: "Markdown", ...shareButtons }
  );
});

bot.onText(/\/status/, async (msg) => {
  const userId = msg.from.id;
  const pending = await Message.countDocuments({ receiverId: userId, status: "pending" });
  const unlocked = await Message.countDocuments({ receiverId: userId, status: "unlocked" });
  await bot.sendMessage(msg.chat.id, `📊 *Your Stats*\nPending messages: ${pending}\nUnlocked messages: ${unlocked}\nUse /mymessages to see list.`, { parse_mode: "Markdown" });
});

bot.onText(/\/random/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const activeUser = await User.findOne({ userId: { $ne: userId }, lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }).sort({ lastActive: -1 }).limit(1);
  if (!activeUser) {
    await bot.sendMessage(chatId, "No active users found. Try again later.");
    return;
  }
  await bot.sendMessage(chatId, "✍️ Type your anonymous message (max 500 chars):", { reply_markup: { force_reply: true } });
  global.pendingRandomTarget = activeUser.userId;
});

bot.onText(/\/rank/, async (msg) => {
  const topUsers = await User.aggregate([
    { $lookup: { from: "messages", localField: "userId", foreignField: "receiverId", as: "msgs" } },
    { $addFields: { receivedCount: { $size: "$msgs" } } },
    { $sort: { receivedCount: -1 } },
    { $limit: 10 }
  ]);
  let text = "🏆 *Leaderboard – Most Messages Received*\n\n";
  for (let i = 0; i < topUsers.length; i++) {
    const u = topUsers[i];
    text += `${i+1}. ${u.displayName} – ${u.receivedCount} messages\n`;
  }
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/mymessages/, async (msg) => {
  const userId = msg.from.id;
  const messages = await Message.find({ receiverId: userId }).sort({ createdAt: -1 }).limit(10);
  if (messages.length === 0) {
    await bot.sendMessage(msg.chat.id, "No messages yet.");
    return;
  }
  let text = "📜 *Your last 10 messages*\n\n";
  for (let m of messages) {
    text += `${m.status === "unlocked" ? "🔓" : "🔒"} ${m.preview}... (${new Date(m.createdAt).toLocaleString()})\n`;
  }
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/\/portrait/, async (msg) => {
  const userId = msg.from.id;
  const user = await User.findOne({ userId });
  if (!user) return;
  const portrait = await generateFriendPortrait(userId, user.displayName);
  if (portrait) {
    await bot.sendMessage(msg.chat.id, portrait, { parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(msg.chat.id, "Not enough messages yet (need at least 5 unlocked messages). Keep sharing your link!");
  }
});

bot.onText(/\/stats/, async (msg) => {
  if (msg.from.id !== OWNER_ID) {
    await bot.sendMessage(msg.chat.id, "❌ You are not authorized.");
    return;
  }
  const totalUsers = await User.countDocuments();
  const totalMessages = await Message.countDocuments();
  const pendingMessages = await Message.countDocuments({ status: "pending" });
  const totalStarsPaid = (await Payment.aggregate([{ $group: { _id: null, total: { $sum: "$amountStars" } } }]))[0]?.total || 0;
  await bot.sendMessage(msg.chat.id, `📊 *Bot Stats*\nUsers: ${totalUsers}\nMessages: ${totalMessages}\nPending unlocks: ${pendingMessages}\nStars paid: ${totalStarsPaid}`, { parse_mode: "Markdown" });
});

// ========== MESSAGE HANDLER ==========
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;
  if (!text || text.startsWith("/")) return;

  if (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes("Type your anonymous message")) {
    const targetId = global.pendingRandomTarget || global.pendingTargetUserId;
    if (!targetId) return;
    const canSend = await checkRateLimit(userId, targetId);
    if (!canSend) {
      await bot.sendMessage(chatId, "❌ You've reached your daily limit. Try again tomorrow.");
      return;
    }
    const senderToken = generateToken();
    await createMessage(targetId, text, senderToken);
    await incrementRateLimit(userId, targetId);
    await bot.sendMessage(chatId, "✅ Message sent anonymously.");
    try { await bot.sendMessage(targetId, "📩 You have a new anonymous message! Use /status to see it."); } catch (e) {}
    delete global.pendingRandomTarget;
    delete global.pendingTargetUserId;
  }
});

// ========== CALLBACK QUERY ==========
bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (data.startsWith("send_to_")) {
    const targetUserId = parseInt(data.split("_")[2]);
    const canSend = await checkRateLimit(userId, targetUserId);
    if (!canSend) {
      await bot.answerCallbackQuery(query.id, { text: "Limit reached." });
      return;
    }
    await bot.sendMessage(chatId, "✍️ Type your anonymous message (max 500 chars):", { reply_markup: { force_reply: true } });
    global.pendingTargetUserId = targetUserId;
    await bot.answerCallbackQuery(query.id);
  }

  else if (data.startsWith("unlock_share_")) {
    const messageId = data.split("_")[2];
    const message = await Message.findById(messageId);
    if (!message || message.status !== "pending") return;

    message.status = "unlocked";
    message.unlockMethod = "share";
    message.unlockedAt = new Date();
    await message.save();

    const user = await User.findOne({ userId });
    const refLink = `https://t.me/${cachedBotUsername}?start=ref_${user.userId}`;
    
    await bot.editMessageText(`📩 *Anonymous message (unlocked)*\n\n*"${message.content}"*`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "Markdown"
    });
    await bot.sendMessage(chatId, `🎉 Message unlocked! Share your link: ${refLink}`, { disable_web_page_preview: true });
  }

  else if (data.startsWith("unlock_stars_")) {
    const messageId = data.split("_")[2];
    const message = await Message.findById(messageId);
    if (!message || message.status !== "pending") return;
    const invoice = {
      chat_id: chatId,
      title: "Unlock Anonymous Message",
      description: `Read: "${message.preview}..."`,
      payload: `unlock_pay_${messageId}`,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: "Unlock", amount: 1500 }],
      start_parameter: "unlock"
    };
    await bot.sendInvoice(invoice);
    await bot.answerCallbackQuery(query.id);
  }

  else if (data.startsWith("copy_link_")) {
    const token = data.split("_")[2];
    const user = await User.findOne({ token });
    if (!user) {
      await bot.answerCallbackQuery(query.id, { text: "Link not found." });
      return;
    }
    const link = `https://t.me/${cachedBotUsername}?start=${token}`;
    await bot.sendMessage(chatId, `🔗 *Your anonymous inbox link:*\n${link}\n\nShare it anywhere by copying this message.`, { parse_mode: "Markdown", disable_web_page_preview: true });
    await bot.answerCallbackQuery(query.id, { text: "Link sent! Long-press to copy." });
  }
});

// ========== PAYMENT HANDLERS ==========
bot.on("pre_checkout_query", (query) => bot.answerPreCheckoutQuery(query.id, true));

bot.on("successful_payment", async (msg) => {
  const payload = msg.successful_payment.invoice_payload;
  const userId = msg.from.id;
  const amountStars = msg.successful_payment.total_amount / 100;
  if (payload.startsWith("unlock_pay_")) {
    const messageId = payload.split("_")[2];
    const message = await Message.findById(messageId);
    if (message && message.status === "pending") {
      message.status = "unlocked";
      message.unlockMethod = "stars";
      message.unlockedAt = new Date();
      await message.save();
      await new Payment({ userId, transactionId: msg.successful_payment.telegram_payment_charge_id, amountStars, type: "unlock", messageId: message._id }).save();
      await bot.sendMessage(msg.chat.id, `🎉 *Message unlocked!*\n\n*"${message.content}"*`, { parse_mode: "Markdown" });
    }
  }
});

// ========== DAILY CLEANUP ==========
setInterval(async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await RateLimit.deleteMany({ date: { $lt: yesterday } });
}, 24 * 60 * 60 * 1000);

console.log("🤖 Bot started...");
